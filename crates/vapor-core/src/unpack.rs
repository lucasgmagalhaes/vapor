//! Safe extraction of game artifacts (zip) into the install directory.
//!
//! Artifacts are untrusted input: every entry name is validated (no zip-slip),
//! symlinks are refused, and limits on entry count, per-file size, total size and
//! compression ratio are enforced on the bytes actually written, not on the sizes
//! the archive declares.

use std::collections::HashSet;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use crate::{Error, Result};

#[derive(Debug, Clone)]
pub struct Limits {
    pub max_files: usize,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    /// Maximum total uncompressed size / archive size.
    pub max_ratio: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_files: 5_000,
            max_file_bytes: 256 * 1024 * 1024,
            max_total_bytes: 512 * 1024 * 1024,
            max_ratio: 100,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub files: usize,
    pub bytes: u64,
}

fn bad(msg: impl Into<String>) -> Error {
    Error::InvalidArchive(msg.into())
}

/// Validates an entry name and returns it without the trailing `/` of directories.
fn safe_entry_name(name: &str) -> Result<&str> {
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    let invalid = trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.contains(['\\', '\0', ':'])
        || trimmed.split('/').any(|c| c.is_empty() || c == "." || c == "..");
    if invalid {
        return Err(bad(format!("unsafe entry name: {name:?}")));
    }
    Ok(trimmed)
}

/// Extracts `bytes` (a zip) into `dest`. The extraction happens in a staging
/// directory next to `dest` and is renamed into place only on success, so a failure
/// never leaves a half-extracted game. An existing `dest` is replaced.
pub fn extract_zip(bytes: &[u8], dest: &Path, limits: &Limits) -> Result<Report> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))?;
    if zip.len() > limits.max_files {
        return Err(bad("too many entries"));
    }
    let parent = dest.parent().ok_or_else(|| bad("destination has no parent"))?;
    fs::create_dir_all(parent)?;
    let name = dest.file_name().ok_or_else(|| bad("destination has no name"))?;
    let staging: PathBuf = parent.join(format!(".{}.partial", name.to_string_lossy()));
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir_all(&staging)?;

    match extract_into(&mut zip, &staging, bytes.len() as u64, limits) {
        Ok(report) => {
            if dest.exists() {
                fs::remove_dir_all(dest)?;
            }
            fs::rename(&staging, dest)?;
            Ok(report)
        }
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            Err(e)
        }
    }
}

fn extract_into(
    zip: &mut zip::ZipArchive<Cursor<&[u8]>>,
    root: &Path,
    archive_len: u64,
    limits: &Limits,
) -> Result<Report> {
    let mut seen = HashSet::new();
    let mut files = 0usize;
    let mut total = 0u64;
    let budget = limits.max_total_bytes.min(archive_len.saturating_mul(limits.max_ratio));

    for i in 0..zip.len() {
        let entry = zip.by_index(i)?;
        let rel = safe_entry_name(entry.name())?.to_string();
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err(bad(format!("symlink entries are not allowed: {rel}")));
            }
        }
        if !seen.insert(rel.to_lowercase()) {
            return Err(bad(format!("duplicate entry: {rel}")));
        }
        let target = root.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(dir) = target.parent() {
            fs::create_dir_all(dir)?;
        }
        // create_new: an entry can never overwrite a file or follow a planted link.
        let mut out = fs::OpenOptions::new().write(true).create_new(true).open(&target)?;
        let cap = limits.max_file_bytes.min(budget.saturating_sub(total));
        let mut limited = entry.take(cap + 1);
        let written = std::io::copy(&mut limited, &mut out)?;
        out.flush()?;
        if written > cap {
            return Err(bad(format!("size limit exceeded at {rel}")));
        }
        total += written;
        files += 1;
    }
    Ok(Report { files, bytes: total })
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;

    fn build(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            w.start_file(*name, opts).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    fn extract(bytes: &[u8], limits: &Limits) -> (tempfile::TempDir, Result<Report>) {
        let tmp = tempfile::tempdir().unwrap();
        let r = extract_zip(bytes, &tmp.path().join("game"), limits);
        (tmp, r)
    }

    #[test]
    fn extracts_nested_files() {
        let zip = build(&[("g/index.html", b"<html>"), ("g/data/a.bin", &[1, 2, 3])]);
        let (tmp, r) = extract(&zip, &Limits::default());
        assert_eq!(r.unwrap(), Report { files: 2, bytes: 9 });
        assert_eq!(fs::read(tmp.path().join("game/g/data/a.bin")).unwrap(), [1, 2, 3]);
    }

    #[test]
    fn rejects_unsafe_names() {
        for name in ["../evil", "a/../../evil", "/abs", "a\\b", "C:/x", "a//b", "./a"] {
            let (tmp, r) = extract(&build(&[(name, b"x")]), &Limits::default());
            assert!(matches!(r, Err(Error::InvalidArchive(_))), "{name}");
            assert!(!tmp.path().join("evil").exists());
            assert!(!tmp.path().join("game").exists(), "no partial install for {name}");
        }
    }

    #[test]
    fn rejects_symlinks() {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        w.add_symlink("link", "/etc/passwd", SimpleFileOptions::default()).unwrap();
        let zip = w.finish().unwrap().into_inner();
        let (_t, r) = extract(&zip, &Limits::default());
        assert!(matches!(r, Err(Error::InvalidArchive(_))));
    }

    #[test]
    fn rejects_duplicates_case_insensitively() {
        let zip = build(&[("a.txt", b"1"), ("A.txt", b"2")]);
        let (_t, r) = extract(&zip, &Limits::default());
        assert!(matches!(r, Err(Error::InvalidArchive(_))));
    }

    #[test]
    fn rejects_zip_bomb_by_ratio() {
        let zip = build(&[("zeros", &vec![0u8; 20 * 1024 * 1024])]);
        let (tmp, r) = extract(&zip, &Limits::default());
        assert!(matches!(r, Err(Error::InvalidArchive(_))));
        assert!(!tmp.path().join("game").exists());
    }

    #[test]
    fn enforces_limits_on_written_bytes() {
        let zip = build(&[("a", &[7u8; 2000]), ("b", &[7u8; 10])]);
        let small = Limits { max_file_bytes: 1000, ..Limits::default() };
        assert!(extract(&zip, &small).1.is_err());
        let total = Limits { max_total_bytes: 2005, max_ratio: 10_000, ..Limits::default() };
        assert!(extract(&zip, &total).1.is_err());
        let files = Limits { max_files: 1, ..Limits::default() };
        assert!(extract(&zip, &files).1.is_err());
    }

    #[test]
    fn replaces_existing_install() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("game");
        extract_zip(&build(&[("old.txt", b"1")]), &dest, &Limits::default()).unwrap();
        extract_zip(&build(&[("new.txt", b"2")]), &dest, &Limits::default()).unwrap();
        assert!(!dest.join("old.txt").exists());
        assert!(dest.join("new.txt").exists());
    }
}
