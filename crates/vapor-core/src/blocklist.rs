use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::links::ExternalEntry;
use crate::manifest::GameManifest;
use crate::Result;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlockEntry {
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    /// Date and reference of the takedown request (never the game content).
    pub date: String,
    pub reference: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Blocklist {
    #[serde(default)]
    pub entries: Vec<BlockEntry>,
}

fn host_of(url: &str) -> &str {
    url.trim_start_matches("https://")
        .split(['/', ':', '?', '#'])
        .next()
        .unwrap_or("")
}

impl Blocklist {
    /// Link-only entries are blocked by slug, or by an explicit `domain` entry that is the
    /// link's repository host or a `host/owner/repo` prefix of it.
    pub fn check_link(&self, e: &ExternalEntry) -> Option<&str> {
        let key = e.repo_key();
        self.entries.iter().find_map(|b| {
            let hit = b.slug.as_deref() == Some(e.slug.as_str())
                || b.domain.as_deref().is_some_and(|d| {
                    let d = d.to_ascii_lowercase();
                    d.contains('/') && (key == d || key.starts_with(&format!("{d}/")))
                });
            hit.then_some(b.reference.as_str())
        })
    }

    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        Ok(serde_json::from_slice(&std::fs::read(path)?)?)
    }

    /// Returns the request reference if the manifest matches any entry.
    pub fn check(&self, m: &GameManifest) -> Option<&str> {
        let host = host_of(&m.artifact.url).to_ascii_lowercase();
        self.entries.iter().find_map(|e| {
            let hit = e.slug.as_deref() == Some(m.slug.as_str())
                || e.sha256
                    .as_deref()
                    .is_some_and(|h| h.eq_ignore_ascii_case(&m.artifact.sha256))
                || e.domain.as_deref().is_some_and(|d| {
                    let d = d.to_ascii_lowercase();
                    host == d || host.ends_with(&format!(".{d}"))
                });
            hit.then_some(e.reference.as_str())
        })
    }
}
