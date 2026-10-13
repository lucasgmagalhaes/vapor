//! Local save storage. Each version of a slot is a `.vsave` file
//! (zip with `meta.json` + `files/...`), the same format used for export/import.

use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;

use crate::{Error, Result};

/// How many versions of each slot are kept.
pub const KEEP_VERSIONS: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SaveMeta {
    pub slug: String,
    pub slot: String,
    /// Save format version declared by the game.
    pub save_version: u32,
    /// Hash of the artifact the save was created with.
    pub artifact_sha256: String,
    /// Monotonic per-slot counter (basis for conflict detection).
    pub revision: u64,
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveFile {
    /// Relative path inside the game's virtual FS, e.g. `saves/slot1.dat`.
    pub path: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct SaveData {
    pub meta: SaveMeta,
    pub files: Vec<SaveFile>,
}

pub struct SaveStore {
    root: PathBuf,
}

fn safe_component(s: &str) -> Result<()> {
    let ok = !s.is_empty()
        && s.len() <= 64
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(Error::InvalidSave(format!("invalid identifier: {s:?}")))
    }
}

pub(crate) fn safe_file_path(p: &str) -> Result<()> {
    let bad = p.is_empty()
        || p.starts_with('/')
        || p.contains('\\')
        || p.split('/').any(|c| c.is_empty() || c == "." || c == "..");
    if bad {
        Err(Error::InvalidSave(format!("invalid path: {p:?}")))
    } else {
        Ok(())
    }
}

pub fn encode(data: &SaveData) -> Result<Vec<u8>> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("meta.json", opts)?;
    zip.write_all(&serde_json::to_vec_pretty(&data.meta)?)?;
    for f in &data.files {
        safe_file_path(&f.path)?;
        zip.start_file(format!("files/{}", f.path), opts)?;
        zip.write_all(&f.data)?;
    }
    Ok(zip.finish()?.into_inner())
}

/// Uncompressed size limit, against zip bombs in imported saves.
const MAX_UNCOMPRESSED: u64 = 256 * 1024 * 1024;

pub fn decode(bytes: &[u8]) -> Result<SaveData> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))?;
    let mut meta: Option<SaveMeta> = None;
    let mut files = Vec::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let entry = zip.by_index(i)?;
        let name = entry.name().to_string();
        total += entry.size();
        if total > MAX_UNCOMPRESSED {
            return Err(Error::InvalidSave("save too large".into()));
        }
        let mut buf = Vec::new();
        entry.take(MAX_UNCOMPRESSED).read_to_end(&mut buf)?;
        if name == "meta.json" {
            meta = Some(serde_json::from_slice(&buf)?);
        } else if let Some(rel) = name.strip_prefix("files/") {
            if rel.ends_with('/') {
                continue;
            }
            safe_file_path(rel)?;
            files.push(SaveFile { path: rel.to_string(), data: buf });
        }
    }
    let meta = meta.ok_or_else(|| Error::InvalidSave("meta.json missing".into()))?;
    safe_component(&meta.slug)?;
    safe_component(&meta.slot)?;
    Ok(SaveData { meta, files })
}

impl SaveStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn slot_dir(&self, slug: &str, slot: &str) -> Result<PathBuf> {
        safe_component(slug)?;
        safe_component(slot)?;
        Ok(self.root.join(slug).join(slot))
    }

    fn revisions(dir: &Path) -> Result<Vec<u64>> {
        if !dir.exists() {
            return Ok(vec![]);
        }
        let mut v: Vec<u64> = std::fs::read_dir(dir)?
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let n = e.file_name().to_string_lossy().into_owned();
                n.strip_suffix(".vsave")?.parse().ok()
            })
            .collect();
        v.sort_unstable();
        Ok(v)
    }

    /// Writes a new slot revision and prunes the oldest ones.
    pub fn write(
        &self,
        slug: &str,
        slot: &str,
        save_version: u32,
        artifact_sha256: &str,
        files: Vec<SaveFile>,
        now: u64,
    ) -> Result<SaveMeta> {
        let dir = self.slot_dir(slug, slot)?;
        std::fs::create_dir_all(&dir)?;
        let revs = Self::revisions(&dir)?;
        let revision = revs.last().map_or(1, |r| r + 1);
        let meta = SaveMeta {
            slug: slug.into(),
            slot: slot.into(),
            save_version,
            artifact_sha256: artifact_sha256.into(),
            revision,
            created_at: now,
        };
        let bytes = encode(&SaveData { meta: meta.clone(), files })?;
        // atomic write: never leaves a half-written .vsave
        let tmp = dir.join(format!("{revision}.tmp"));
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, dir.join(format!("{revision}.vsave")))?;
        let revs = Self::revisions(&dir)?;
        if revs.len() > KEEP_VERSIONS {
            for r in &revs[..revs.len() - KEEP_VERSIONS] {
                let _ = std::fs::remove_file(dir.join(format!("{r}.vsave")));
            }
        }
        Ok(meta)
    }

    /// Reads the requested revision, or the latest.
    pub fn read(&self, slug: &str, slot: &str, revision: Option<u64>) -> Result<Option<SaveData>> {
        let dir = self.slot_dir(slug, slot)?;
        let Some(rev) = revision.or_else(|| Self::revisions(&dir).ok()?.last().copied()) else {
            return Ok(None);
        };
        let path = dir.join(format!("{rev}.vsave"));
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(decode(&std::fs::read(path)?)?))
    }

    pub fn list_slots(&self, slug: &str) -> Result<Vec<SaveMeta>> {
        safe_component(slug)?;
        let game_dir = self.root.join(slug);
        if !game_dir.exists() {
            return Ok(vec![]);
        }
        let mut out = Vec::new();
        for e in std::fs::read_dir(game_dir)? {
            let slot = e?.file_name().to_string_lossy().into_owned();
            if let Some(d) = self.read(slug, &slot, None)? {
                out.push(d.meta);
            }
        }
        out.sort_by(|a, b| a.slot.cmp(&b.slot));
        Ok(out)
    }

    pub fn list_revisions(&self, slug: &str, slot: &str) -> Result<Vec<u64>> {
        Self::revisions(&self.slot_dir(slug, slot)?)
    }

    pub fn export(&self, slug: &str, slot: &str, revision: Option<u64>) -> Result<Vec<u8>> {
        let d = self
            .read(slug, slot, revision)?
            .ok_or_else(|| Error::InvalidSave("slot not found".into()))?;
        encode(&d)
    }

    /// Imports a `.vsave` as a new slot revision (never overwrites).
    pub fn import(&self, bytes: &[u8], now: u64) -> Result<SaveMeta> {
        let d = decode(bytes)?;
        self.write(
            &d.meta.slug,
            &d.meta.slot,
            d.meta.save_version,
            &d.meta.artifact_sha256,
            d.files,
            now,
        )
    }

    /// Deletes all saves of a game (the player's right to removal).
    pub fn delete_game(&self, slug: &str) -> Result<()> {
        safe_component(slug)?;
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

    fn f(path: &str, data: &[u8]) -> SaveFile {
        SaveFile { path: path.into(), data: data.to_vec() }
    }

    #[test]
    fn write_read_prune_and_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let s = SaveStore::new(tmp.path());
        for i in 0..8u8 {
            s.write("g", "s1", 1, "aa", vec![f("a/b.dat", &[i])], 100 + i as u64).unwrap();
        }
        assert_eq!(s.list_revisions("g", "s1").unwrap().len(), KEEP_VERSIONS);
        let latest = s.read("g", "s1", None).unwrap().unwrap();
        assert_eq!(latest.meta.revision, 8);
        assert_eq!(latest.files[0].data, vec![7]);

        let bytes = s.export("g", "s1", None).unwrap();
        let other = tempfile::tempdir().unwrap();
        let s2 = SaveStore::new(other.path());
        let meta = s2.import(&bytes, 1).unwrap();
        assert_eq!(meta.revision, 1);
        assert_eq!(s2.read("g", "s1", None).unwrap().unwrap().files, latest.files);
    }

    #[test]
    fn rejects_path_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let s = SaveStore::new(tmp.path());
        assert!(s.write("../x", "s", 1, "a", vec![], 0).is_err());
        assert!(s.write("g", "s", 1, "a", vec![f("../evil", b"x")], 0).is_err());
        assert!(s.write("g", "s", 1, "a", vec![f("/abs", b"x")], 0).is_err());
    }

    #[test]
    fn delete_game_removes_everything() {
        let tmp = tempfile::tempdir().unwrap();
        let s = SaveStore::new(tmp.path());
        s.write("g", "s1", 1, "a", vec![], 0).unwrap();
        s.delete_game("g").unwrap();
        assert!(s.list_slots("g").unwrap().is_empty());
    }
}
