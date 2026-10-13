//! Thin layer between the UI and `vapor-core`. All business logic lives in the core.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use vapor_core::catalog::Catalog;
use vapor_core::manifest::{verify_artifact, GameManifest};
use vapor_core::byo::ByoStatus;
use vapor_core::saves::{SaveMeta, SaveStore};
use vapor_core::{audit, unpack};

/// catalog.json is published by CI on every merge to `main` (branch `catalog`).
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
    /// Installed games that left the catalog (e.g. takedown) and were removed.
    pub removed: Vec<String>,
}

/// Downloads the catalog and applies removals: whatever left the index is deleted
/// from disk (the player's saves are preserved).
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

/// Downloads the manifest's artifact and only writes it if size and SHA-256 match.
#[tauri::command]
pub async fn install_game(app: AppHandle, slug: String) -> CmdResult<()> {
    let game = read_cached(&app)?
        .games
        .into_iter()
        .find(|g| g.slug == slug)
        .ok_or("game is not in the catalog")?;
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
    let files = dir.join("files");
    tokio::task::spawn_blocking(move || {
        unpack::extract_zip(&bytes, &files, &unpack::Limits::default())
    })
    .await
    .map_err(err)?
    .map_err(err)?;
    // Defense in depth: scan what was just extracted, whatever the catalog says. A blocking
    // finding (native executable, malformed wasm, miner...) removes the install again.
    let scanned = dir.join("files");
    let report = tokio::task::spawn_blocking(move || audit::audit_dir(&scanned))
        .await
        .map_err(err)?
        .map_err(err)?;
    if report.blocked() {
        let why: Vec<String> = report
            .findings
            .iter()
            .filter(|f| f.severity == audit::Severity::Block)
            .map(|f| format!("{} ({})", f.key(), f.path))
            .collect();
        let _ = tokio::fs::remove_dir_all(&dir).await;
        return Err(format!("install blocked by the security scan: {}", why.join(", ")));
    }
    tokio::fs::write(dir.join("game.json"), serde_json::to_vec(&game).map_err(err)?)
        .await
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn uninstall_game(app: AppHandle, slug: String) -> CmdResult<()> {
    if slug.contains(['/', '\\']) || slug.contains("..") {
        return Err("invalid slug".into());
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

/// Exports the slot to `dest` (path chosen by the user in the dialog).
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

/// Opens an installed game in its own isolated window.
#[tauri::command]
pub async fn play_game(app: AppHandle, slug: String) -> CmdResult<()> {
    crate::game::open(&app, &slug)
}

fn installed_manifest(app: &AppHandle, slug: &str) -> CmdResult<GameManifest> {
    if slug.contains(['/', '\\']) || slug.contains("..") {
        return Err("invalid slug".into());
    }
    let bytes = std::fs::read(installed_dir(app)?.join(slug).join("game.json"))
        .map_err(|_| "game is not installed".to_string())?;
    serde_json::from_slice(&bytes).map_err(err)
}

/// Which player-supplied files a bring-your-own game still needs.
#[tauri::command]
pub fn byo_status(app: AppHandle, slug: String) -> CmdResult<Vec<ByoStatus>> {
    let m = installed_manifest(&app, &slug)?;
    crate::game::byo_store(&app).ok_or("no data dir")?.status(&slug, &m.byo_files).map_err(err)
}

/// Verifies a file the player picked against the manifest and copies it into the
/// local store. Nothing leaves the machine; a wrong file is rejected, never stored.
#[tauri::command]
pub async fn byo_import(app: AppHandle, slug: String, name: String, src: String) -> CmdResult<()> {
    let m = installed_manifest(&app, &slug)?;
    let spec = m
        .byo_files
        .iter()
        .find(|f| f.name == name)
        .ok_or("this game does not ask for that file")?
        .clone();
    let store = crate::game::byo_store(&app).ok_or("no data dir")?;
    tokio::task::spawn_blocking(move || -> CmdResult<()> {
        // Check the size first so a wrong, huge file is never read into memory.
        let len = std::fs::metadata(&src).map_err(err)?.len();
        if len != spec.size {
            return Err(format!("{}: size {len} does not match the expected {}", spec.name, spec.size));
        }
        let bytes = std::fs::read(&src).map_err(err)?;
        store.import(&slug, &spec, &bytes).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Removes the player's stored files for a game (saves are untouched).
#[tauri::command]
pub fn byo_clear(app: AppHandle, slug: String) -> CmdResult<()> {
    crate::game::byo_store(&app).ok_or("no data dir")?.delete_game(&slug).map_err(err)
}
