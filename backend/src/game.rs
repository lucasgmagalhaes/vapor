//! Running an installed game: a separate-origin custom protocol, a window with no
//! Tauri IPC, and the save bridge. Path/size/format validation lives in `vapor-core`.

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use vapor_core::byo::ByoStore;
use vapor_core::manifest::GameManifest;
use vapor_core::saves::SaveStore;
use vapor_core::{bridge, serve};

pub const SCHEME: &str = "vapor-game";
const SAVE_SLOT: &str = "auto";
const BRIDGE_JS: &str = include_str!("game_bridge.js");

/// What a game window is allowed to reach. Looked up by an unguessable per-window
/// token that is the first segment of every URL the window loads.
#[derive(Clone)]
struct Session {
    slug: String,
    files: PathBuf,
    save_roots: Vec<String>,
    save_version: u32,
    artifact_sha256: String,
    /// Names of the player-supplied files this game may fetch.
    byo: Vec<String>,
}

#[derive(Default)]
pub struct Sessions(Mutex<HashMap<String, Session>>);

fn origin() -> &'static str {
    if cfg!(any(windows, target_os = "android")) {
        "http://vapor-game.localhost"
    } else {
        "vapor-game://localhost"
    }
}

/// 128 bits from the operating system's RNG: the token is the only thing separating one game
/// window from another game's files and saves.
fn random_token() -> String {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).expect("the OS random number generator is unavailable");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn text(status: StatusCode, msg: &str) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header("X-Content-Type-Options", "nosniff")
        .body(Cow::Owned(msg.as_bytes().to_vec()))
        .expect("static response")
}

fn store(app: &AppHandle) -> Option<SaveStore> {
    Some(SaveStore::new(app.path().app_data_dir().ok()?.join("saves")))
}

pub fn byo_store(app: &AppHandle) -> Option<ByoStore> {
    Some(ByoStore::new(app.path().app_data_dir().ok()?.join("byo")))
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn decode_path(raw: &str) -> Option<String> {
    percent_encoding::percent_decode_str(raw).decode_utf8().ok().map(|s| s.into_owned())
}

/// Entry point of the `vapor-game` protocol.
pub fn handle(app: &AppHandle, req: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let Some(path) = decode_path(req.uri().path()) else {
        return text(StatusCode::BAD_REQUEST, "bad path");
    };
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    let (token, rest) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let session = {
        let sessions = app.state::<Sessions>();
        let guard = sessions.0.lock().expect("sessions lock");
        guard.get(token).cloned()
    };
    let Some(session) = session else {
        return text(StatusCode::NOT_FOUND, "unknown session");
    };
    if rest == "__vapor/saves" {
        return saves(app, &session, &req);
    }
    if let Some(name) = rest.strip_prefix("__vapor/byo/") {
        return byo(app, &session, name);
    }
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return text(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }
    let Ok(file) = serve::resolve(&session.files, rest) else {
        return text(StatusCode::BAD_REQUEST, "bad path");
    };
    match std::fs::read(&file) {
        Ok(bytes) => Response::builder()
            .header(header::CONTENT_TYPE, serve::mime_for(&file))
            .header(header::CONTENT_SECURITY_POLICY, serve::GAME_CSP)
            .header("Permissions-Policy", serve::PERMISSIONS_POLICY)
            .header("Referrer-Policy", "no-referrer")
            .header("Cross-Origin-Resource-Policy", "same-origin")
            .header("X-Content-Type-Options", "nosniff")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Cow::Owned(bytes))
            .expect("file response"),
        Err(_) => text(StatusCode::NOT_FOUND, "not found"),
    }
}

/// Hands a player-supplied file to the window of the game that declared it.
fn byo(app: &AppHandle, s: &Session, name: &str) -> Response<Cow<'static, [u8]>> {
    if !s.byo.iter().any(|n| n == name) {
        return text(StatusCode::NOT_FOUND, "not declared by this game");
    }
    match byo_store(app).map(|b| b.read(&s.slug, name)) {
        Some(Ok(Some(bytes))) => Response::builder()
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header("X-Content-Type-Options", "nosniff")
            .body(Cow::Owned(bytes))
            .expect("byo response"),
        _ => text(StatusCode::NOT_FOUND, "file not provided"),
    }
}

fn saves(app: &AppHandle, s: &Session, req: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let Some(store) = store(app) else {
        return text(StatusCode::INTERNAL_SERVER_ERROR, "no data dir");
    };
    let json = |body: Vec<u8>| {
        Response::builder()
            .header(header::CONTENT_TYPE, "application/json")
            .body(Cow::Owned(body))
            .expect("json response")
    };
    match *req.method() {
        Method::GET => match store.read(&s.slug, SAVE_SLOT, None) {
            Ok(data) => {
                let files = data.map(|d| d.files).unwrap_or_default();
                match bridge::render_get(&files) {
                    Ok(b) => json(b),
                    Err(e) => text(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
                }
            }
            Err(e) => text(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        },
        Method::PUT => {
            let files = match bridge::parse_put(req.body(), &s.save_roots) {
                Ok(f) => f,
                Err(e) => return text(StatusCode::BAD_REQUEST, &e.to_string()),
            };
            let unchanged = matches!(
                store.read(&s.slug, SAVE_SLOT, None),
                Ok(Some(d)) if bridge::same_files(&d.files, &files)
            );
            if !unchanged {
                if let Err(e) = store.write(
                    &s.slug,
                    SAVE_SLOT,
                    s.save_version,
                    &s.artifact_sha256,
                    files,
                    now(),
                ) {
                    return text(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
                }
            }
            text(StatusCode::OK, "ok")
        }
        _ => text(StatusCode::METHOD_NOT_ALLOWED, "method not allowed"),
    }
}

/// Opens the installed game in its own window.
pub fn open(app: &AppHandle, slug: &str) -> Result<(), String> {
    if slug.contains(['/', '\\']) || slug.contains("..") {
        return Err("invalid slug".into());
    }
    let label = format!("game-{slug}");
    if let Some(w) = app.get_webview_window(&label) {
        return w.set_focus().map_err(|e| e.to_string());
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = data_dir.join("installed").join(slug);
    let manifest: GameManifest = serde_json::from_slice(
        &std::fs::read(dir.join("game.json")).map_err(|_| "game is not installed".to_string())?,
    )
    .map_err(|e| e.to_string())?;
    manifest.validate(slug).map_err(|e| e.to_string())?;
    let files = dir.join("files");
    let entry = serve::resolve(&files, &manifest.artifact.entry).map_err(|e| e.to_string())?;
    if !entry.is_file() {
        return Err("entry file is missing; reinstall the game".into());
    }

    if !manifest.byo_files.is_empty() {
        let store = byo_store(app).ok_or("no data dir")?;
        let missing = store.missing(slug, &manifest.byo_files).map_err(|e| e.to_string())?;
        if !missing.is_empty() {
            return Err(format!("missing files: {}", missing.join(", ")));
        }
    }

    let token = random_token();
    app.state::<Sessions>().0.lock().expect("sessions lock").insert(
        token.clone(),
        Session {
            slug: slug.to_string(),
            files,
            save_roots: manifest.saves.paths.clone(),
            save_version: manifest.saves.version,
            artifact_sha256: manifest.artifact.sha256.clone(),
            byo: manifest.byo_files.iter().map(|f| f.name.clone()).collect(),
        },
    );

    let prefix = format!("{}/{token}/", origin());
    let url: Url = format!("{prefix}{}", manifest.artifact.entry).parse().map_err(|e| format!("{e}"))?;
    let roots = serde_json::to_string(&manifest.saves.paths).map_err(|e| e.to_string())?;
    let mounts: Vec<_> = manifest
        .byo_files
        .iter()
        .map(|f| serde_json::json!({ "name": f.name, "mount": f.mount }))
        .collect();
    let script = BRIDGE_JS
        .replace("__VAPOR_SAVE_ROOTS__", &roots)
        .replace("__VAPOR_BYO__", &serde_json::Value::Array(mounts).to_string());

    let nav_prefix = prefix.clone();
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(&manifest.title)
        .inner_size(1000.0, 720.0)
        .data_directory(data_dir.join("webview").join(slug))
        .initialization_script(script)
        .on_navigation(move |u| u.as_str().starts_with(&nav_prefix))
        // A game may not open other windows (pop-ups, ad pages): the CSP cannot stop `window.open`.
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny)
        .build()
        .map_err(|e| e.to_string());
    let window = match window {
        Ok(w) => w,
        Err(e) => {
            app.state::<Sessions>().0.lock().expect("sessions lock").remove(&token);
            return Err(e);
        }
    };

    let handle = app.clone();
    let w = window.clone();
    window.on_window_event(move |event| match event {
        // Give the page a moment to flush its saves before the webview goes away.
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = w.eval("window.__vaporFlush && window.__vaporFlush()");
            let w = w.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(700));
                let _ = w.destroy();
            });
        }
        WindowEvent::Destroyed => {
            handle.state::<Sessions>().0.lock().expect("sessions lock").remove(&token);
        }
        _ => {}
    });
    Ok(())
}
