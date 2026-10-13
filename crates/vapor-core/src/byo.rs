//! Local store for `bring-your-own` files.
//!
//! The player picks files they own; each one is checked against the size and SHA-256
//! the manifest declares and then copied into Vapor's data directory. Nothing here
//! touches the network, and the files are only ever handed to that game's window.

use std::path::PathBuf;

use sha2::{Digest, Sha256};

use crate::manifest::ByoFile;
use crate::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ByoStatus {
    pub name: String,
    pub description: String,
    pub size: u64,
    pub present: bool,
}

pub struct ByoStore {
    root: PathBuf,
}

fn bad(msg: impl Into<String>) -> Error {
    Error::InvalidByo(msg.into())
}

fn safe_slug(s: &str) -> Result<()> {
    let ok = !s.is_empty()
        && s.len() <= 64
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(bad("invalid slug"))
    }
}

fn safe_name(s: &str) -> Result<()> {
    let ok = !s.is_empty()
        && s.len() <= 64
        && !s.starts_with('.')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(())
    } else {
        Err(bad("invalid file name"))
    }
}

/// Checks size and SHA-256 of a file the player supplied.
pub fn verify_file(spec: &ByoFile, bytes: &[u8]) -> Result<()> {
    if bytes.len() as u64 != spec.size {
        return Err(bad(format!(
            "{}: size {} does not match the expected {}",
            spec.name,
            bytes.len(),
            spec.size
        )));
    }
    if !hex::encode(Sha256::digest(bytes)).eq_ignore_ascii_case(&spec.sha256) {
        return Err(bad(format!("{}: this is not the expected file (hash mismatch)", spec.name)));
    }
    Ok(())
}

impl ByoStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn path(&self, slug: &str, name: &str) -> Result<PathBuf> {
        safe_slug(slug)?;
        safe_name(name)?;
        Ok(self.root.join(slug).join(name))
    }

    /// Verifies `bytes` and stores them atomically. Wrong files are never written.
    pub fn import(&self, slug: &str, spec: &ByoFile, bytes: &[u8]) -> Result<()> {
        let path = self.path(slug, &spec.name)?;
        verify_file(spec, bytes)?;
        std::fs::create_dir_all(path.parent().expect("has parent"))?;
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    pub fn read(&self, slug: &str, name: &str) -> Result<Option<Vec<u8>>> {
        let path = self.path(slug, name)?;
        match std::fs::read(path) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn status(&self, slug: &str, specs: &[ByoFile]) -> Result<Vec<ByoStatus>> {
        specs
            .iter()
            .map(|s| {
                let present = self.path(slug, &s.name)?.is_file();
                Ok(ByoStatus {
                    name: s.name.clone(),
                    description: s.description.clone(),
                    size: s.size,
                    present,
                })
            })
            .collect()
    }

    pub fn missing(&self, slug: &str, specs: &[ByoFile]) -> Result<Vec<String>> {
        Ok(self.status(slug, specs)?.into_iter().filter(|s| !s.present).map(|s| s.name).collect())
    }

    pub fn delete_game(&self, slug: &str) -> Result<()> {
        safe_slug(slug)?;
        let dir = self.root.join(slug);
        if dir.exists() {
            std::fs::remove_dir_all(dir)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(bytes: &[u8]) -> ByoFile {
        ByoFile {
            name: "disc1.bin".into(),
            description: "Disc 1".into(),
            sha256: hex::encode(Sha256::digest(bytes)),
            size: bytes.len() as u64,
            mount: "/game/disc1.bin".into(),
        }
    }

    #[test]
    fn import_verifies_and_stores() {
        let tmp = tempfile::tempdir().unwrap();
        let store = ByoStore::new(tmp.path());
        let s = spec(b"my game data");
        assert_eq!(store.missing("g", std::slice::from_ref(&s)).unwrap(), vec!["disc1.bin"]);
        store.import("g", &s, b"my game data").unwrap();
        assert_eq!(store.read("g", "disc1.bin").unwrap().unwrap(), b"my game data");
        assert!(store.missing("g", &[s]).unwrap().is_empty());
    }

    #[test]
    fn wrong_files_are_rejected_and_not_written() {
        let tmp = tempfile::tempdir().unwrap();
        let store = ByoStore::new(tmp.path());
        let s = spec(b"my game data");
        assert!(store.import("g", &s, b"my game dat4").is_err(), "same size, other hash");
        assert!(store.import("g", &s, b"short").is_err(), "wrong size");
        assert!(store.read("g", "disc1.bin").unwrap().is_none());
    }

    #[test]
    fn rejects_unsafe_identifiers() {
        let tmp = tempfile::tempdir().unwrap();
        let store = ByoStore::new(tmp.path());
        let mut s = spec(b"x");
        assert!(store.import("../g", &s, b"x").is_err());
        assert!(store.import("G", &s, b"x").is_err());
        s.name = "../evil".into();
        assert!(store.import("g", &s, b"x").is_err());
        assert!(store.read("g", "a/b").is_err());
    }

    #[test]
    fn delete_game_removes_only_that_game() {
        let tmp = tempfile::tempdir().unwrap();
        let store = ByoStore::new(tmp.path());
        let s = spec(b"x");
        store.import("a", &s, b"x").unwrap();
        store.import("b", &s, b"x").unwrap();
        store.delete_game("a").unwrap();
        assert!(store.read("a", "disc1.bin").unwrap().is_none());
        assert!(store.read("b", "disc1.bin").unwrap().is_some());
    }
}
