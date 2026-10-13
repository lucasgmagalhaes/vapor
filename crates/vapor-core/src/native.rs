//! Rules for running a reviewed native build (see `links::NativeBuild`).
//!
//! Pure, testable pieces; the backend does the I/O (download, spawn). What "verified" means
//! here, and nothing more: the asset matches the size and SHA-256 a named reviewer pinned, every
//! extracted file matches the digest recorded at install time, and both are re-checked before
//! EVERY launch. Vapor cannot sandbox native code: it runs with the player's permissions.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::links::NativeBuild;
use crate::{serve, Error, Result};

fn bad(msg: impl Into<String>) -> Error {
    Error::InvalidArchive(msg.into())
}

/// The platform this build of Vapor can run natively (`windows` or `linux`).
pub fn platform() -> Option<&'static str> {
    if cfg!(target_os = "windows") {
        Some("windows")
    } else if cfg!(target_os = "linux") {
        Some("linux")
    } else {
        None
    }
}

/// The player's system, as far as running pinned native builds is concerned.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct System {
    /// `windows`, `linux`, `macos` or whatever `std::env::consts::OS` says.
    pub os: String,
    pub arch: String,
    /// True when Vapor can run a pinned native build here: Windows or Linux on x86-64 (the builds
    /// are x86-64 programs; Vapor does not emulate).
    pub native_ok: bool,
}

pub fn system() -> System {
    system_of(std::env::consts::OS, std::env::consts::ARCH)
}

pub fn system_of(os: &str, arch: &str) -> System {
    System { os: os.into(), arch: arch.into(), native_ok: matches!(os, "windows" | "linux") && arch == "x86_64" }
}

/// Size and SHA-256 of a downloaded asset against what the reviewer pinned.
pub fn verify_asset(build: &NativeBuild, bytes: &[u8]) -> Result<()> {
    if bytes.len() as u64 != build.size {
        return Err(bad(format!("size {} does not match the reviewed {}", bytes.len(), build.size)));
    }
    if !hex::encode(Sha256::digest(bytes)).eq_ignore_ascii_case(&build.sha256) {
        return Err(bad("sha256 does not match the reviewed build"));
    }
    Ok(())
}

/// Where the program lives inside `files_dir` after installation.
pub fn exe_path(files_dir: &Path, build: &NativeBuild) -> Result<PathBuf> {
    if build.is_zip() {
        serve::resolve(files_dir, &build.exe)
    } else if build.exe == build.asset_name() {
        serve::resolve(files_dir, &build.exe)
    } else {
        Err(bad("for a plain (non-zip) asset, exe must be the asset's own file name"))
    }
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut f = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

/// `relative path -> sha256` for every file under `root`; symlinks are refused.
pub fn tree_digest(root: &Path) -> Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in fs::read_dir(&dir)? {
            let e = e?;
            let ft = e.file_type()?;
            let path = e.path();
            if ft.is_symlink() {
                return Err(bad(format!("symlink in an installed build: {}", path.display())));
            } else if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() {
                let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                out.insert(rel, sha256_file(&path)?);
            }
        }
    }
    Ok(out)
}

/// Fails if anything in `root` was added, removed or modified since `expected` was recorded.
pub fn check_tree(root: &Path, expected: &BTreeMap<String, String>) -> Result<()> {
    let now = tree_digest(root)?;
    if &now != expected {
        let changed: Vec<_> = expected
            .keys()
            .chain(now.keys())
            .filter(|k| expected.get(*k) != now.get(*k))
            .take(3)
            .cloned()
            .collect();
        return Err(bad(format!("installed files changed since they were verified: {}", changed.join(", "))));
    }
    Ok(())
}

/// The only environment variables a launched game receives: no tokens, no credentials.
pub fn clean_env(env: impl Iterator<Item = (String, String)>) -> Vec<(String, String)> {
    const KEEP: &[&str] = &[
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "APPDATA",
        "LOCALAPPDATA", "HOME", "USER", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE", "XDG_DATA_DIRS", "DBUS_SESSION_BUS_ADDRESS",
        "PULSE_SERVER", "VK_ICD_FILENAMES",
    ];
    env.filter(|(k, _)| KEEP.iter().any(|keep| k.eq_ignore_ascii_case(keep))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(url: &str, exe: &str, bytes: &[u8]) -> NativeBuild {
        NativeBuild {
            platform: "windows".into(),
            url: url.into(),
            sha256: hex::encode(Sha256::digest(bytes)),
            size: bytes.len() as u64,
            exe: exe.into(),
            reviewed_by: "m".into(),
            reviewed_on: "2026-10-13".into(),
            trust: "scanned".into(),
            notes: String::new(),
        }
    }

    #[test]
    fn asset_must_match_the_reviewed_hash_and_size() {
        let b = build("https://github.com/o/r/releases/download/v1/g.zip", "g/run.exe", b"payload");
        assert!(verify_asset(&b, b"payload").is_ok());
        assert!(verify_asset(&b, b"payloae").is_err(), "same size, other content");
        assert!(verify_asset(&b, b"payload!").is_err(), "other size");
    }

    #[test]
    fn exe_path_is_confined_to_the_install_dir() {
        let root = Path::new("/n/files");
        let zip = build("https://github.com/o/r/releases/download/v1/g.zip", "g/run.exe", b"x");
        assert_eq!(exe_path(root, &zip).unwrap(), root.join("g/run.exe"));
        for evil in ["../run.exe", "/etc/passwd", "a/../../x", "C:/x.exe"] {
            let mut b = zip.clone();
            b.exe = evil.into();
            assert!(exe_path(root, &b).is_err(), "{evil}");
        }
        let plain = build("https://github.com/o/r/releases/download/v1/Game.AppImage", "Game.AppImage", b"x");
        assert!(exe_path(root, &plain).is_ok());
        let mut other = plain.clone();
        other.exe = "other".into();
        assert!(exe_path(root, &other).is_err(), "a plain asset can only start itself");
    }

    #[test]
    fn tampering_after_install_is_detected() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join("g")).unwrap();
        fs::write(d.path().join("g/run.exe"), b"original").unwrap();
        fs::write(d.path().join("g/data.bin"), b"data").unwrap();
        let recorded = tree_digest(d.path()).unwrap();
        assert!(check_tree(d.path(), &recorded).is_ok());

        fs::write(d.path().join("g/run.exe"), b"patched!").unwrap();
        assert!(check_tree(d.path(), &recorded).is_err(), "modified file");
        fs::write(d.path().join("g/run.exe"), b"original").unwrap();
        assert!(check_tree(d.path(), &recorded).is_ok());
        fs::write(d.path().join("g/extra.dll"), b"dropped").unwrap();
        assert!(check_tree(d.path(), &recorded).is_err(), "planted file");
        fs::remove_file(d.path().join("g/extra.dll")).unwrap();
        fs::remove_file(d.path().join("g/data.bin")).unwrap();
        assert!(check_tree(d.path(), &recorded).is_err(), "deleted file");
    }

    #[test]
    fn the_child_environment_has_no_secrets() {
        let env = vec![
            ("PATH".to_string(), "/bin".to_string()),
            ("GITHUB_TOKEN".to_string(), "ghp_x".to_string()),
            ("AWS_SECRET_ACCESS_KEY".to_string(), "x".to_string()),
            ("Path".to_string(), "C:\\Windows".to_string()),
            ("DISPLAY".to_string(), ":0".to_string()),
            ("ANTHROPIC_API_KEY".to_string(), "x".to_string()),
        ];
        let kept: Vec<String> = clean_env(env.into_iter()).into_iter().map(|(k, _)| k).collect();
        assert_eq!(kept, vec!["PATH", "Path", "DISPLAY"]);
    }

    #[test]
    fn native_builds_need_windows_or_linux_on_x86_64() {
        assert!(system_of("windows", "x86_64").native_ok);
        assert!(system_of("linux", "x86_64").native_ok);
        assert!(!system_of("macos", "aarch64").native_ok);
        assert!(!system_of("macos", "x86_64").native_ok);
        assert!(!system_of("windows", "aarch64").native_ok, "no emulation");
        assert!(!system_of("linux", "aarch64").native_ok);
    }

    #[test]
    fn platform_is_known_on_supported_systems() {
        if cfg!(any(target_os = "windows", target_os = "linux")) {
            assert!(platform().is_some());
        }
    }
}
