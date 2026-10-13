//! Pure helpers for serving an installed game to its isolated webview:
//! safe path resolution, MIME types and the Content-Security-Policy.

use std::path::{Path, PathBuf};

use crate::{Error, Result};

/// CSP sent with every game response. The game may only talk to its own origin:
/// no network, no frames, no forms. `'unsafe-inline'` scripts and `wasm-unsafe-eval`
/// are needed by Emscripten pages; the isolation comes from the separate origin,
/// the per-window storage and the absence of any Tauri IPC in the game window.
pub const GAME_CSP: &str = "default-src 'none'; \
script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; \
style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob:; \
media-src 'self' data: blob:; \
font-src 'self' data:; \
connect-src 'self' data: blob:; \
worker-src 'self' blob:; \
object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// Resolves a URL path (already percent-decoded, relative to the game's `files`
/// directory) to a file path inside `root`. Rejects anything that could escape it.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf> {
    let invalid = rel.is_empty()
        || rel.starts_with('/')
        || rel.contains(['\\', '\0', ':'])
        || rel.split('/').any(|c| c.is_empty() || c == "." || c == "..");
    if invalid {
        return Err(Error::InvalidArchive(format!("invalid path: {rel:?}")));
    }
    Ok(root.join(rel))
}

pub fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("wasm") => "application/wasm",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("mp3") => "audio/mpeg",
        Some("txt" | "cfg") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_accepts_nested_and_rejects_escapes() {
        let root = Path::new("/r");
        assert_eq!(resolve(root, "a/b.js").unwrap(), root.join("a/b.js"));
        for bad in ["", "/etc/passwd", "../x", "a/../../x", "a\\b", "C:/x", "a//b", "a/./b", "a\0b"] {
            assert!(resolve(root, bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn mime_types() {
        assert_eq!(mime_for(Path::new("x.WASM")), "application/wasm");
        assert_eq!(mime_for(Path::new("index.html")), "text/html; charset=utf-8");
        assert_eq!(mime_for(Path::new("doom1.wad")), "application/octet-stream");
    }

    #[test]
    fn csp_blocks_network_and_frames() {
        assert!(GAME_CSP.contains("default-src 'none'"));
        assert!(GAME_CSP.contains("connect-src 'self'"));
        assert!(!GAME_CSP.contains("http:") && !GAME_CSP.contains("https:"));
    }
}
