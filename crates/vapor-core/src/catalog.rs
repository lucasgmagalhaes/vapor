use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::blocklist::Blocklist;
use crate::manifest::GameManifest;
use crate::{Error, Result};

/// Índice gerado a partir de `games/*/game.json`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Catalog {
    pub games: Vec<GameManifest>,
}

impl Catalog {
    /// Lê, valida e filtra pela blocklist. Qualquer manifesto inválido ou
    /// bloqueado faz o build falhar (a CI recusa o PR).
    pub fn build(games_dir: &Path, blocklist: &Blocklist) -> Result<Self> {
        let mut games = Vec::new();
        for entry in std::fs::read_dir(games_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let slug = entry.file_name().to_string_lossy().into_owned();
            let bytes = std::fs::read(entry.path().join("game.json"))?;
            let m: GameManifest = serde_json::from_slice(&bytes)?;
            m.validate(&slug)?;
            if let Some(reference) = blocklist.check(&m) {
                return Err(Error::Blocked(format!("{slug} ({reference})")));
            }
            games.push(m);
        }
        games.sort_by(|a, b| a.slug.cmp(&b.slug));
        Ok(Self { games })
    }

    pub fn search(&self, query: &str) -> Vec<&GameManifest> {
        let q = query.trim().to_lowercase();
        self.games
            .iter()
            .filter(|g| {
                q.is_empty()
                    || g.title.to_lowercase().contains(&q)
                    || g.slug.contains(&q)
                    || g.tags.iter().any(|t| t.to_lowercase().contains(&q))
            })
            .collect()
    }
}
