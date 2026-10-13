use serde::{Deserialize, Serialize};

use crate::{Error, Result};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AssetsPolicy {
    /// Whole game under an open license.
    Open,
    /// Open-source code; assets (ROM etc.) are supplied by the player and never sent to Vapor.
    BringYourOwn,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Artifact {
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub entry: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Source {
    pub repo: String,
    pub commit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct License {
    pub code: String,
    pub assets: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SaveConfig {
    /// Directories of the wasm virtual FS that persist.
    pub paths: Vec<String>,
    /// Save format version of the game.
    pub version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GameManifest {
    pub schema: u32,
    pub slug: String,
    pub title: String,
    pub authors: Vec<String>,
    pub source: Source,
    pub license: License,
    pub assets_policy: AssetsPolicy,
    pub artifact: Artifact,
    pub saves: SaveConfig,
    #[serde(default)]
    pub tags: Vec<String>,
    pub contact: String,
}

fn valid_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && !s.starts_with('-')
        && !s.ends_with('-')
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

impl GameManifest {
    /// Validates rules the JSON Schema alone does not cover.
    /// `dir_slug` is the name of the folder the manifest lives in.
    pub fn validate(&self, dir_slug: &str) -> Result<()> {
        let bad = |reason: &str| Error::InvalidManifest {
            path: dir_slug.to_string(),
            reason: reason.to_string(),
        };
        if self.schema != SCHEMA_VERSION {
            return Err(bad("unsupported schema"));
        }
        if !valid_slug(&self.slug) {
            return Err(bad("slug must be [a-z0-9-], up to 64 chars"));
        }
        if self.slug != dir_slug {
            return Err(bad("slug differs from folder name"));
        }
        if self.title.trim().is_empty() || self.authors.is_empty() {
            return Err(bad("title and authors are required"));
        }
        if !self.artifact.url.starts_with("https://") {
            return Err(bad("artifact.url must be https"));
        }
        if self.artifact.sha256.len() != 64
            || !self.artifact.sha256.chars().all(|c| c.is_ascii_hexdigit())
        {
            return Err(bad("artifact.sha256 must be 64 hex chars"));
        }
        if self.artifact.size == 0 {
            return Err(bad("artifact.size must be > 0"));
        }
        if self.saves.paths.iter().any(|p| !p.starts_with('/') || p.contains("..")) {
            return Err(bad("saves.paths must be absolute and contain no '..'"));
        }
        if !self.contact.contains('@') && !self.contact.starts_with("https://") {
            return Err(bad("contact must be an e-mail or https URL"));
        }
        Ok(())
    }
}

/// Checks size and SHA-256 of a downloaded artifact before any execution.
pub fn verify_artifact(a: &Artifact, bytes: &[u8]) -> Result<()> {
    use sha2::{Digest, Sha256};
    if bytes.len() as u64 != a.size {
        return Err(Error::InvalidManifest {
            path: a.url.clone(),
            reason: format!("size {} != expected {}", bytes.len(), a.size),
        });
    }
    let got = hex::encode(Sha256::digest(bytes));
    if !got.eq_ignore_ascii_case(&a.sha256) {
        return Err(Error::InvalidManifest {
            path: a.url.clone(),
            reason: "sha256 does not match manifest".into(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn sample() -> GameManifest {
        GameManifest {
            schema: 1,
            slug: "demo-game".into(),
            title: "Demo".into(),
            authors: vec!["a".into()],
            source: Source { repo: "https://github.com/a/b".into(), commit: "abc".into() },
            license: License { code: "MIT".into(), assets: "MIT".into() },
            assets_policy: AssetsPolicy::Open,
            artifact: Artifact {
                url: "https://example.com/g.wasm".into(),
                sha256: "a".repeat(64),
                size: 3,
                entry: "index.html".into(),
            },
            saves: SaveConfig { paths: vec!["/saves".into()], version: 1 },
            tags: vec![],
            contact: "a@b.c".into(),
        }
    }

    #[test]
    fn validates_ok_and_rejects_bad() {
        assert!(sample().validate("demo-game").is_ok());
        assert!(sample().validate("other").is_err());
        let mut m = sample();
        m.artifact.url = "http://x".into();
        assert!(m.validate("demo-game").is_err());
        let mut m = sample();
        m.saves.paths = vec!["/a/../b".into()];
        assert!(m.validate("demo-game").is_err());
    }

    #[test]
    fn verify_artifact_checks_hash() {
        use sha2::{Digest, Sha256};
        let mut a = sample().artifact;
        a.sha256 = hex::encode(Sha256::digest(b"abc"));
        assert!(verify_artifact(&a, b"abc").is_ok());
        assert!(verify_artifact(&a, b"abd").is_err());
        assert!(verify_artifact(&a, b"abcd").is_err());
    }

    #[test]
    fn blocklist_matches_slug_hash_domain() {
        use crate::blocklist::{BlockEntry, Blocklist};
        let e = |slug: Option<&str>, sha: Option<String>, dom: Option<&str>| Blocklist {
            entries: vec![BlockEntry {
                slug: slug.map(Into::into),
                sha256: sha,
                domain: dom.map(Into::into),
                date: "2026-01-01".into(),
                reference: "ref-1".into(),
            }],
        };
        let m = sample();
        assert!(e(Some("demo-game"), None, None).check(&m).is_some());
        assert!(e(None, Some("A".repeat(64)), None).check(&m).is_some());
        assert!(e(None, None, Some("example.com")).check(&m).is_some());
        assert!(e(None, None, Some("ample.com")).check(&m).is_none());
        assert!(e(Some("other"), None, None).check(&m).is_none());
    }
}
