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
/// Where a cover URL written by hand (found through a public API) may point. The repository never
/// stores a copy of official art: it only records where the image is served from.
pub const ALLOWED_COVER_HOSTS: &[&str] = &[
    "upload.wikimedia.org",
    "shared.fastly.steamstatic.com",
    "cdn.cloudflare.steamstatic.com",
    "cdn.akamai.steamstatic.com",
    "images.igdb.com",
    "media.rawg.io",
    "image.api.playstation.com",
];

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

/// An https image URL on one of `ALLOWED_COVER_HOSTS`: no credentials, no port, a plain path to a
/// jpg/png/webp file and at most a short harmless query (Steam adds a cache-busting `?t=`).
pub fn valid_external_cover(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let (host, tail) = rest.split_once('/').unwrap_or((rest, ""));
    if !ALLOWED_COVER_HOSTS.contains(&host) || url.len() > 400 || tail.is_empty() {
        return false;
    }
    let (path, query) = tail.split_once('?').unwrap_or((tail, ""));
    let path_ok = path.chars().all(|c| c.is_ascii_alphanumeric() || "/._%-,()".contains(c)) && !path.contains("..");
    let ext_ok = ["jpg", "jpeg", "png", "webp"].iter().any(|e| path.to_ascii_lowercase().ends_with(&format!(".{e}")));
    let query_ok = query.len() <= 40 && query.chars().all(|c| c.is_ascii_alphanumeric() || "=&._-".contains(c));
    path_ok && ext_ok && query_ok
}

/// A wide image for details and highlights. PlayStation's official media server uses
/// extensionless image paths, so accept only its image endpoint and fixed size presets.
pub fn valid_external_backdrop(url: &str) -> bool {
    if valid_external_cover(url) {
        return true;
    }
    let Some(tail) = url.strip_prefix("https://gmedia.playstation.com/is/image/SIEPDC/") else { return false };
    let Some((name, size)) = tail.split_once('?') else { return false };
    !name.is_empty()
        && name.len() <= 160
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && matches!(size, "$1200px$" | "$1600px$" | "$2400px$")
}

/// Anything the app may show as a cover: ours (from `covers/`) or an allowed external image.
pub fn valid_any_cover(url: &str) -> bool {
    valid_cover_url(url) || valid_external_cover(url)
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
    fn external_covers_only_from_allowed_hosts_and_plain_image_paths() {
        for ok in [
            "https://upload.wikimedia.org/wikipedia/en/thumb/a/ab/Bloodborne_Cover_Wallpaper.jpg/460px-Bloodborne_Cover_Wallpaper.jpg",
            "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1536610/header.jpg?t=1700000000",
            "https://cdn.cloudflare.steamstatic.com/steam/apps/1536610/header.jpg",
            "https://images.igdb.com/igdb/image/upload/t_cover_big/co1abc.jpg",
            "https://media.rawg.io/media/games/abc/abcdef.jpg",
        ] {
            assert!(valid_external_cover(ok), "{ok}");
        }
        for bad in [
            "http://upload.wikimedia.org/a.jpg",
            "https://evil.example/a.jpg",
            "https://upload.wikimedia.org.evil.example/a.jpg",
            "https://user:pw@upload.wikimedia.org/a.jpg",
            "https://upload.wikimedia.org:8443/a.jpg",
            "https://upload.wikimedia.org/a.svg",
            "https://upload.wikimedia.org/../a.jpg",
            "https://upload.wikimedia.org/a.jpg?x=<script>",
            "https://upload.wikimedia.org/",
            "https://upload.wikimedia.org",
            "javascript:alert(1)",
        ] {
            assert!(!valid_external_cover(bad), "{bad}");
        }
        assert!(valid_any_cover(&cover_url("x")) && valid_any_cover("https://cdn.cloudflare.steamstatic.com/a.png"));
    }

    #[test]
    fn official_playstation_artwork_urls_are_constrained() {
        assert!(valid_external_cover("https://image.api.playstation.com/vulcan/img/rnd/202011/0711/p8JCvA8692BICXAPoyylh7ed.png"));
        assert!(valid_external_backdrop("https://gmedia.playstation.com/is/image/SIEPDC/god-of-war-iii-remastered-hero-banner-desktop-01-en-18aug21?$1200px$"));
        assert!(!valid_external_backdrop("https://gmedia.playstation.com/is/image/SIEPDC/../secret?$1200px$"));
        assert!(!valid_external_backdrop("https://gmedia.playstation.com/is/image/SIEPDC/art?$99999px$"));
        assert!(!valid_external_backdrop("https://gmedia.playstation.com/other/art?$1200px$"));
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
