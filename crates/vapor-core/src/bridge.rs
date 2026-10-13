//! Wire format between a running game and the `SaveStore`.
//!
//! The game page is untrusted. It sends the files of its wasm virtual FS as JSON
//! (`{"files":[{"path":"/dir/file","data":"<base64>"}]}`); everything is validated
//! here before it reaches the store: paths must be absolute-in-the-VFS, free of
//! `..`/`\`, and inside one of the directories the manifest declares in `saves.paths`.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::saves::{safe_file_path, SaveFile};
use crate::{Error, Result};

/// Upper bound for a request body and for the decoded total.
pub const MAX_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_FILES: usize = 10_000;

#[derive(Serialize, Deserialize)]
struct WireFile {
    path: String,
    data: String,
}

#[derive(Serialize, Deserialize)]
struct Wire {
    files: Vec<WireFile>,
}

fn bad(msg: impl Into<String>) -> Error {
    Error::InvalidSave(msg.into())
}

/// `/` allows everything; `/a/b/` and `/a/b` allow files below `/a/b`.
fn within(roots: &[String], path: &str) -> bool {
    roots.iter().any(|r| {
        let r = r.trim_end_matches('/');
        r.is_empty() || path.strip_prefix(r).is_some_and(|rest| rest.starts_with('/'))
    })
}

/// Parses and validates a save request sent by the game.
pub fn parse_put(body: &[u8], roots: &[String]) -> Result<Vec<SaveFile>> {
    if body.len() > MAX_BYTES {
        return Err(bad("payload too large"));
    }
    let wire: Wire = serde_json::from_slice(body)?;
    if wire.files.len() > MAX_FILES {
        return Err(bad("too many files"));
    }
    let mut total = 0usize;
    let mut out = Vec::with_capacity(wire.files.len());
    for f in wire.files {
        let rel = f.path.strip_prefix('/').ok_or_else(|| bad("path must be absolute"))?;
        safe_file_path(rel)?;
        if !within(roots, &f.path) {
            return Err(bad(format!("path outside the save directories: {}", f.path)));
        }
        let data = STANDARD.decode(f.data).map_err(|e| bad(format!("bad base64: {e}")))?;
        total += data.len();
        if total > MAX_BYTES {
            return Err(bad("payload too large"));
        }
        out.push(SaveFile { path: rel.to_string(), data });
    }
    Ok(out)
}

/// Serializes stored files for the game to restore into its virtual FS.
pub fn render_get(files: &[SaveFile]) -> Result<Vec<u8>> {
    let wire = Wire {
        files: files
            .iter()
            .map(|f| WireFile { path: format!("/{}", f.path), data: STANDARD.encode(&f.data) })
            .collect(),
    };
    Ok(serde_json::to_vec(&wire)?)
}

/// Order-insensitive equality, used to skip writing a revision when nothing changed
/// (otherwise idle autosaves would evict real revisions from the 5-version window).
pub fn same_files(a: &[SaveFile], b: &[SaveFile]) -> bool {
    let (mut a, mut b): (Vec<_>, Vec<_>) = (a.iter().collect(), b.iter().collect());
    a.sort_by(|x, y| x.path.cmp(&y.path));
    b.sort_by(|x, y| x.path.cmp(&y.path));
    a == b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(files: &[(&str, &[u8])]) -> Vec<u8> {
        let wire = Wire {
            files: files
                .iter()
                .map(|(p, d)| WireFile { path: p.to_string(), data: STANDARD.encode(d) })
                .collect(),
        };
        serde_json::to_vec(&wire).unwrap()
    }

    fn roots(r: &[&str]) -> Vec<String> {
        r.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn roundtrip_inside_roots() {
        let b = body(&[("/libsdl/doom/save0.dsg", b"abc"), ("/libsdl/doom/cfg", b"x")]);
        let files = parse_put(&b, &roots(&["/libsdl/doom"])).unwrap();
        assert_eq!(files[0].path, "libsdl/doom/save0.dsg");
        let back = parse_put(&render_get(&files).unwrap(), &roots(&["/libsdl/doom/"])).unwrap();
        assert!(same_files(&files, &back));
    }

    #[test]
    fn rejects_paths_outside_roots_and_traversal() {
        let r = roots(&["/libsdl/doom"]);
        for p in [
            "/etc/passwd",
            "/libsdl/doom2/x",
            "/libsdl/doom/../x",
            "/libsdl/doom//x",
            "libsdl/doom/x",
            "/libsdl/doom\\x",
            "/libsdl/doom",
        ] {
            assert!(parse_put(&body(&[(p, b"x")]), &r).is_err(), "{p}");
        }
    }

    #[test]
    fn root_slash_allows_all_valid_paths() {
        assert!(parse_put(&body(&[("/a/b", b"x")]), &roots(&["/"])).is_ok());
        assert!(parse_put(&body(&[("/a/../b", b"x")]), &roots(&["/"])).is_err());
    }

    #[test]
    fn rejects_bad_json_base64_and_size() {
        let r = roots(&["/"]);
        assert!(parse_put(b"not json", &r).is_err());
        assert!(parse_put(br#"{"files":[{"path":"/a","data":"!!"}]}"#, &r).is_err());
        assert!(parse_put(&vec![b' '; MAX_BYTES + 1], &r).is_err());
    }

    #[test]
    fn same_files_ignores_order_but_not_content() {
        let f = |p: &str, d: &[u8]| SaveFile { path: p.into(), data: d.to_vec() };
        assert!(same_files(&[f("a", b"1"), f("b", b"2")], &[f("b", b"2"), f("a", b"1")]));
        assert!(!same_files(&[f("a", b"1")], &[f("a", b"2")]));
        assert!(!same_files(&[f("a", b"1")], &[]));
    }
}
