use std::path::Path;

use serde::{Deserialize, Serialize};

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
    /// Data e referência do pedido de remoção (sem o conteúdo do jogo).
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
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        Ok(serde_json::from_slice(&std::fs::read(path)?)?)
    }

    /// Retorna a referência do pedido se o manifesto bate com alguma entrada.
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
