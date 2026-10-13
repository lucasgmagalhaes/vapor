//! Camada fina entre a UI e `vapor-core`. Toda regra de negócio vive no core.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use vapor_core::catalog::Catalog;
use vapor_core::manifest::{verify_artifact, GameManifest};
use vapor_core::saves::{SaveMeta, SaveStore};

/// catalog.json é publicado pela CI a cada merge em `main` (branch `catalog`).
const CATALOG_URL: &str =
    "https://raw.githubusercontent.com/lucasgmagalhaes/vapor/catalog/catalog.json";

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn data_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    app.path().app_data_dir().map_err(err)
}

fn saves(app: &AppHandle) -> CmdResult<SaveStore> {
    Ok(SaveStore::new(data_dir(app)?.join("saves")))
}

fn installed_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(data_dir(app)?.join("installed"))
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn read_cached(app: &AppHandle) -> CmdResult<Catalog> {
    let p = data_dir(app)?.join("catalog.json");
    if !p.exists() {
        return Ok(Catalog::default());
    }
    serde_json::from_slice(&std::fs::read(p).map_err(err)?).map_err(err)
}

#[tauri::command]
pub fn get_catalog(app: AppHandle, query: Option<String>) -> CmdResult<Vec<GameManifest>> {
    let c = read_cached(&app)?;
    Ok(c.search(query.as_deref().unwrap_or("")).into_iter().cloned().collect())
}

#[derive(Serialize)]
pub struct RefreshResult {
    pub total: usize,
    /// Jogos instalados que saíram do catálogo (ex.: takedown) e foram removidos.
    pub removed: Vec<String>,
}

/// Baixa o catálogo e aplica remoções: o que saiu do índice é apagado
/// do disco (os saves do jogador são preservados).
#[tauri::command]
pub async fn refresh_catalog(app: AppHandle) -> CmdResult<RefreshResult> {
    let bytes = reqwest::get(CATALOG_URL)
        .await
        .and_then(|r| r.error_for_status())
        .map_err(err)?
        .bytes()
        .await
        .map_err(err)?;
    let catalog: Catalog = serde_json::from_slice(&bytes).map_err(err)?;
    let dir = data_dir(&app)?;
    tokio::fs::create_dir_all(&dir).await.map_err(err)?;
    tokio::fs::write(dir.join("catalog.json"), &bytes).await.map_err(err)?;

    let mut removed = Vec::new();
    let inst = installed_dir(&app)?;
    if inst.exists() {
        for e in std::fs::read_dir(&inst).map_err(err)?.flatten() {
            let slug = e.file_name().to_string_lossy().into_owned();
            if !catalog.games.iter().any(|g| g.slug == slug) {
                let _ = std::fs::remove_dir_all(e.path());
                removed.push(slug);
            }
        }
    }
    Ok(RefreshResult { total: catalog.games.len(), removed })
}

/// Baixa o artefato do manifesto e só grava se tamanho e SHA-256 conferirem.
#[tauri::command]
pub async fn install_game(app: AppHandle, slug: String) -> CmdResult<()> {
    let game = read_cached(&app)?
        .games
        .into_iter()
        .find(|g| g.slug == slug)
        .ok_or("jogo não está no catálogo")?;
    let bytes = reqwest::get(&game.artifact.url)
        .await
        .and_then(|r| r.error_for_status())
        .map_err(err)?
        .bytes()
        .await
        .map_err(err)?;
    verify_artifact(&game.artifact, &bytes).map_err(err)?;
    let dir = installed_dir(&app)?.join(&game.slug);
    tokio::fs::create_dir_all(&dir).await.map_err(err)?;
    tokio::fs::write(dir.join("artifact.bin"), &bytes).await.map_err(err)?;
    tokio::fs::write(dir.join("game.json"), serde_json::to_vec(&game).map_err(err)?)
        .await
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn uninstall_game(app: AppHandle, slug: String) -> CmdResult<()> {
    if slug.contains(['/', '\\']) || slug.contains("..") {
        return Err("slug inválido".into());
    }
    let dir = installed_dir(&app)?.join(slug);
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn installed_games(app: AppHandle) -> CmdResult<Vec<String>> {
    let inst = installed_dir(&app)?;
    if !inst.exists() {
        return Ok(vec![]);
    }
    let mut v: Vec<String> = std::fs::read_dir(inst)
        .map_err(err)?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    Ok(v)
}

#[tauri::command]
pub fn list_saves(app: AppHandle, slug: String) -> CmdResult<Vec<SaveMeta>> {
    saves(&app)?.list_slots(&slug).map_err(err)
}

/// Exporta o slot para `dest` (caminho escolhido pelo usuário no diálogo).
#[tauri::command]
pub fn export_save(app: AppHandle, slug: String, slot: String, dest: String) -> CmdResult<()> {
    let bytes = saves(&app)?.export(&slug, &slot, None).map_err(err)?;
    std::fs::write(dest, bytes).map_err(err)
}

#[tauri::command]
pub fn import_save(app: AppHandle, src: String) -> CmdResult<SaveMeta> {
    let bytes = std::fs::read(src).map_err(err)?;
    saves(&app)?.import(&bytes, now()).map_err(err)
}

#[tauri::command]
pub fn delete_game_saves(app: AppHandle, slug: String) -> CmdResult<()> {
    saves(&app)?.delete_game(&slug).map_err(err)
}
