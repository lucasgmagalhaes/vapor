use serde::{Deserialize, Serialize};

use crate::{Error, Result};

pub const SCHEMA_VERSION: u32 = 1;

/// Artifacts are only accepted from Vapor's own build repository: every one of them comes
/// from a pinned, audited workflow (`vapor-artifacts/.github/workflows/build-<slug>.yml`).
/// A manifest pointing anywhere else is rejected, whatever its hash says.
pub const ARTIFACT_URL_PREFIX: &str =
    "https://github.com/lucasgmagalhaes/vapor-artifacts/releases/download/";

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

/// A file the player must supply for a `bring-your-own` game. It is checked against
/// `size` and `sha256` on the player's machine and never uploaded anywhere.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ByoFile {
    /// Identifier, also the file name inside Vapor's local store.
    pub name: String,
    /// What to ask the player for, e.g. "Disc 1 image (.bin)".
    pub description: String,
    pub sha256: String,
    pub size: u64,
    /// Where the file is mounted in the wasm virtual FS.
    pub mount: String,
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
    /// Required for `bring-your-own` games, empty otherwise.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub byo_files: Vec<ByoFile>,
    /// Declares this entry a deliberate variant (fork, port, different engine) of another
    /// game, which lets two entries share a title. Without it, same-title entries are
    /// rejected as duplicates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant_of: Option<String>,
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
        if !self.artifact.url.starts_with(ARTIFACT_URL_PREFIX) {
            return Err(bad("artifact.url must point to a Release of lucasgmagalhaes/vapor-artifacts"));
        }
        if !self.source.repo.starts_with("https://") || self.source.repo.contains(char::is_whitespace) {
            return Err(bad("source.repo must be an https URL"));
        }
        if let Some(v) = &self.variant_of {
            if !valid_slug(v) || *v == self.slug {
                return Err(bad("variant_of must be the slug of another game"));
            }
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
        self.validate_byo(&bad)?;
        if !self.contact.contains('@') && !self.contact.starts_with("https://") {
            return Err(bad("contact must be an e-mail or https URL"));
        }
        Ok(())
    }
}

impl GameManifest {
    fn validate_byo(&self, bad: &dyn Fn(&str) -> Error) -> Result<()> {
        match (&self.assets_policy, self.byo_files.is_empty()) {
            (AssetsPolicy::BringYourOwn, true) => {
                return Err(bad("bring-your-own games must list byo_files"))
            }
            (AssetsPolicy::Open, false) => return Err(bad("byo_files requires bring-your-own")),
            _ => {}
        }
        let mut names = std::collections::HashSet::new();
        for f in &self.byo_files {
            let name_ok = !f.name.is_empty()
                && f.name.len() <= 64
                && f.name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                && !f.name.starts_with('.');
            if !name_ok || !names.insert(f.name.as_str()) {
                return Err(bad("byo_files names must be unique [A-Za-z0-9._-]"));
            }
            if f.sha256.len() != 64 || !f.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(bad("byo_files sha256 must be 64 hex chars"));
            }
            if f.size == 0 || f.description.trim().is_empty() {
                return Err(bad("byo_files need a size and a description"));
            }
            let m = f.mount.as_str();
            let mount_ok = m.starts_with('/')
                && !m.ends_with('/')
                && !m.contains('\\')
                && m[1..].split('/').all(|c| !c.is_empty() && c != "." && c != "..");
            if !mount_ok {
                return Err(bad("byo_files mount must be an absolute VFS path without '..'"));
            }
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
                url: format!("{ARTIFACT_URL_PREFIX}demo-game-1/demo-game.zip"),
                sha256: "a".repeat(64),
                size: 3,
                entry: "index.html".into(),
            },
            saves: SaveConfig { paths: vec!["/saves".into()], version: 1 },
            byo_files: vec![],
            variant_of: None,
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
        m.artifact.url = "https://evil.example/vapor-artifacts/releases/download/x.zip".into();
        assert!(m.validate("demo-game").is_err(), "only our artifacts repository is accepted");
        for repo in ["javascript:alert(1)", "http://github.com/a/b", "file:///etc/passwd", "https://a b"] {
            let mut m = sample();
            m.source.repo = repo.into();
            assert!(m.validate("demo-game").is_err(), "{repo}");
        }
        let mut m = sample();
        m.variant_of = Some("demo-game".into());
        assert!(m.validate("demo-game").is_err(), "a game cannot be a variant of itself");
        let mut m = sample();
        m.saves.paths = vec!["/a/../b".into()];
        assert!(m.validate("demo-game").is_err());
    }

    fn byo_sample() -> GameManifest {
        let mut m = sample();
        m.assets_policy = AssetsPolicy::BringYourOwn;
        m.byo_files = vec![ByoFile {
            name: "disc1.bin".into(),
            description: "Disc 1 image".into(),
            sha256: "b".repeat(64),
            size: 10,
            mount: "/game/disc1.bin".into(),
        }];
        m
    }

    #[test]
    fn byo_manifest_rules() {
        assert!(byo_sample().validate("demo-game").is_ok());
        let mut m = byo_sample();
        m.byo_files.clear();
        assert!(m.validate("demo-game").is_err(), "byo needs files");
        let mut m = byo_sample();
        m.assets_policy = AssetsPolicy::Open;
        assert!(m.validate("demo-game").is_err(), "open cannot list byo files");
        for mount in ["game/x", "/a/../x", "/a//x", "/a\\x", "/a/", "/"] {
            let mut m = byo_sample();
            m.byo_files[0].mount = mount.into();
            assert!(m.validate("demo-game").is_err(), "{mount}");
        }
        for name in ["", "../x", "a/b", ".hidden", "a b"] {
            let mut m = byo_sample();
            m.byo_files[0].name = name.into();
            assert!(m.validate("demo-game").is_err(), "{name:?}");
        }
        let mut m = byo_sample();
        m.byo_files.push(m.byo_files[0].clone());
        assert!(m.validate("demo-game").is_err(), "duplicate names");
        let mut m = byo_sample();
        m.byo_files[0].sha256 = "zz".into();
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
        assert!(e(None, None, Some("github.com")).check(&m).is_some());
        assert!(e(None, None, Some("ithub.com")).check(&m).is_none());
        assert!(e(Some("other"), None, None).check(&m).is_none());
    }
}
