//! Cover images ("capsules", like a store page): `covers/<key>.webp`, one per game or per linked
//! game group. The repository only holds small, validated WebP files; `vapor index` attaches the
//! public URL (served from the `catalog` branch) to the catalog entry, and the app loads it lazily.
//! The app never trusts a cover URL it did not expect: only `COVER_URL_PREFIX/<key>.webp` is shown.

use std::collections::BTreeSet;
use std::io::Read;
use std::path::Path;

use crate::{Error, Result};

/// Where `catalog.yml` publishes `covers/` (the `catalog` branch of this repository).
pub const COVER_URL_PREFIX: &str = "https://raw.githubusercontent.com/lucasgmagalhaes/vapor/catalog/covers/";
/// A cover is a thumbnail, not artwork storage.
pub const MAX_COVER_BYTES: u64 = 250 * 1024;

fn valid_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 64 && k.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn cover_url(key: &str) -> String {
    format!("{COVER_URL_PREFIX}{key}.webp")
}

/// Exactly `COVER_URL_PREFIX<key>.webp` with a valid key: nothing else is ever displayed.
pub fn valid_cover_url(url: &str) -> bool {
    url.strip_prefix(COVER_URL_PREFIX)
        .and_then(|rest| rest.strip_suffix(".webp"))
        .is_some_and(valid_key)
}

/// A WebP container starts with `RIFF<size>WEBP`.
pub fn is_webp(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
}

fn bad(msg: impl Into<String>) -> Error {
    Error::InvalidManifest { path: "covers".into(), reason: msg.into() }
}

/// Keys (`<key>.webp`) of the covers in `dir`; a missing directory means no covers.
/// Every file must be a real small WebP named after a known game or group.
pub fn check_dir(dir: &Path, known: &BTreeSet<String>) -> Result<BTreeSet<String>> {
    let mut keys = BTreeSet::new();
    if !dir.exists() {
        return Ok(keys);
    }
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        let key = name
            .strip_suffix(".webp")
            .filter(|k| valid_key(k))
            .ok_or_else(|| bad(format!("{name}: only <slug>.webp files belong in covers/")))?;
        if !known.contains(key) {
            return Err(bad(format!("{name}: no game or link group called \"{key}\" (orphan cover)")));
        }
        let len = std::fs::metadata(&path)?.len();
        if len > MAX_COVER_BYTES {
            return Err(bad(format!("{name}: {len} bytes, covers are limited to {MAX_COVER_BYTES}")));
        }
        let mut head = [0u8; 16];
        let n = std::fs::File::open(&path)?.read(&mut head)?;
        if !is_webp(&head[..n]) {
            return Err(bad(format!("{name}: not a WebP image")));
        }
        keys.insert(key.to_string());
    }
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn webp() -> Vec<u8> {
        let mut v = b"RIFF".to_vec();
        v.extend([0x10, 0, 0, 0]);
        v.extend(b"WEBPVP8 ");
        v.extend([0u8; 16]);
        v
    }

    fn known(keys: &[&str]) -> BTreeSet<String> {
        keys.iter().map(|k| k.to_string()).collect()
    }

    #[test]
    fn only_our_own_cover_urls_are_valid() {
        assert!(valid_cover_url(&cover_url("doom-freedoom")));
        for bad in [
            "https://evil.example/covers/x.webp",
            "javascript:alert(1)",
            &format!("{COVER_URL_PREFIX}x.png"),
            &format!("{COVER_URL_PREFIX}../secret.webp"),
            &format!("{COVER_URL_PREFIX}A_B.webp"),
            &format!("{COVER_URL_PREFIX}.webp"),
            &format!("{COVER_URL_PREFIX}a/b.webp"),
        ] {
            assert!(!valid_cover_url(bad), "{bad}");
        }
    }

    #[test]
    fn webp_header_detection() {
        assert!(is_webp(&webp()));
        assert!(!is_webp(b"\x89PNG\r\n\x1a\n........"));
        assert!(!is_webp(b"RIFF....WAVEfmt "));
        assert!(!is_webp(b""));
    }

    #[test]
    fn covers_directory_rules() {
        let d = tempfile::tempdir().unwrap();
        assert!(check_dir(&d.path().join("nope"), &known(&[])).unwrap().is_empty());
        std::fs::write(d.path().join("doom.webp"), webp()).unwrap();
        assert_eq!(check_dir(d.path(), &known(&["doom"])).unwrap(), known(&["doom"]));
        assert!(check_dir(d.path(), &known(&["other"])).is_err(), "orphan cover");

        std::fs::write(d.path().join("fake.webp"), b"<script>alert(1)</script>").unwrap();
        assert!(check_dir(d.path(), &known(&["doom", "fake"])).is_err(), "not a WebP");
        std::fs::remove_file(d.path().join("fake.webp")).unwrap();

        std::fs::write(d.path().join("big.webp"), [webp(), vec![0u8; 300 * 1024]].concat()).unwrap();
        assert!(check_dir(d.path(), &known(&["doom", "big"])).is_err(), "too large");
        std::fs::remove_file(d.path().join("big.webp")).unwrap();

        std::fs::write(d.path().join("notes.txt"), "x").unwrap();
        assert!(check_dir(d.path(), &known(&["doom"])).is_err(), "only webp files");
    }
}
