//! Download, verify and launch a native build of a link entry (see `vapor_core::links::NativeBuild`).
//!
//! The order matters and never changes: the asset must match the pinned size and SHA-256 before a
//! single byte is written; the installed tree is digested and recorded at install time; and that
//! digest is checked again before EVERY launch, so a file swapped or planted afterwards stops the
//! run. The program starts with a scrubbed environment (no tokens or credentials). Vapor cannot
//! sandbox native code: it runs with the player's own permissions, which is why the UI asks for an
//! explicit confirmation and shows how the build was vouched for (`reviewed` vs `scanned`).

use std::collections::BTreeMap;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};
use vapor_core::links::NativeBuild;
use vapor_core::{native as rules, unpack};

type R<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn install_dir(app: &AppHandle, slug: &str, build: &NativeBuild) -> R<PathBuf> {
    let base = app.path().app_data_dir().map_err(err)?;
    Ok(base.join("native").join(slug).join(&build.sha256.to_ascii_lowercase()[..16]))
}

#[cfg(unix)]
fn make_executable(path: &std::path::Path) -> R<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).map_err(err)
}

#[cfg(not(unix))]
fn make_executable(_: &std::path::Path) -> R<()> {
    Ok(())
}

/// Downloads, verifies and unpacks the build into `dir`, then records the digest of every file.
async fn install(build: &NativeBuild, dir: &PathBuf) -> R<()> {
    let bytes = crate::commands::download_exact(&build.url, build.size).await?;
    rules::verify_asset(build, &bytes).map_err(err)?;
    let files = dir.join("files");
    let build = build.clone();
    let dir2 = dir.clone();
    let result = tokio::task::spawn_blocking(move || -> R<()> {
        std::fs::create_dir_all(&dir2).map_err(err)?;
        if build.is_zip() {
            let limits = unpack::Limits {
                max_files: 100_000,
                max_file_bytes: 4 * 1024 * 1024 * 1024,
                max_total_bytes: 8 * 1024 * 1024 * 1024,
                max_ratio: 1_000,
            };
            unpack::extract_zip(&bytes, &files, &limits).map_err(err)?;
        } else {
            std::fs::create_dir_all(&files).map_err(err)?;
            let target = rules::exe_path(&files, &build).map_err(err)?;
            std::fs::write(&target, &bytes).map_err(err)?;
            make_executable(&target)?;
        }
        let digest = rules::tree_digest(&files).map_err(err)?;
        std::fs::write(dir2.join("tree.json"), serde_json::to_vec(&digest).map_err(err)?).map_err(err)?;
        Ok(())
    })
    .await
    .map_err(err)?;
    if result.is_err() {
        let _ = std::fs::remove_dir_all(dir);
    }
    result
}

/// Installs (first time) or re-verifies (every time) the build and starts it. Returns the PID.
pub async fn run(app: AppHandle, slug: String, confirm: String) -> R<u32> {
    if confirm != slug {
        return Err("type the project's name (its slug) exactly to confirm running native code".into());
    }
    let platform = rules::platform().ok_or("native builds run only on Windows and Linux")?;
    let entry = crate::commands::cached_links(&app)?
        .into_iter()
        .find(|l| l.slug == slug && l.visible())
        .ok_or("unknown project, or its source is no longer available")?;
    let build = entry
        .native_for(platform)
        .ok_or("this project has no pinned native build for your system")?
        .clone();

    let dir = install_dir(&app, &slug, &build)?;
    let files = dir.join("files");
    let tree_file = dir.join("tree.json");
    if !tree_file.exists() {
        install(&build, &dir).await?;
    }

    // Verify before EVERY launch.
    let expected: BTreeMap<String, String> =
        serde_json::from_slice(&std::fs::read(&tree_file).map_err(err)?).map_err(err)?;
    let check_dir = files.clone();
    tokio::task::spawn_blocking(move || rules::check_tree(&check_dir, &expected))
        .await
        .map_err(err)?
        .map_err(err)?;

    let exe = rules::exe_path(&files, &build).map_err(err)?;
    if !exe.is_file() {
        return Err("the program listed for this build is missing from the package".into());
    }
    let child = std::process::Command::new(&exe)
        .current_dir(exe.parent().unwrap_or(&files))
        .env_clear()
        .envs(rules::clean_env(std::env::vars()))
        .spawn()
        .map_err(err)?;
    Ok(child.id())
}
