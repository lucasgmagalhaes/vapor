use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::blocklist::Blocklist;
use crate::manifest::GameManifest;
use crate::{Error, Result};

/// Index built from `games/*/game.json`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Catalog {
    pub games: Vec<GameManifest>,
    /// Non-fatal findings (for example a probable duplicate); not part of `catalog.json`.
    #[serde(skip)]
    pub warnings: Vec<String>,
}

/// Lower-case alphanumerics only, so "Open TTD", "open-ttd" and "OpenTTD" compare equal.
fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// `https://GitHub.com/Owner/Repo.git/` and `https://github.com/owner/repo` are the same repo.
fn norm_repo(url: &str) -> String {
    let u = url.trim().trim_end_matches('/').trim_end_matches(".git").to_lowercase();
    u.strip_prefix("https://").or_else(|| u.strip_prefix("http://")).unwrap_or(&u).to_string()
}

fn words(title: &str) -> std::collections::BTreeSet<String> {
    title
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() > 1)
        .map(str::to_lowercase)
        .collect()
}

/// Hard duplicates fail the build; probable ones are returned as warnings.
///
/// Hard: same source repository, same artifact hash, or same normalized title unless one
/// entry declares `variant_of` the other. Soft: strongly overlapping titles.
fn check_duplicates(games: &[GameManifest]) -> Result<Vec<String>> {
    let mut warnings = Vec::new();
    for (i, a) in games.iter().enumerate() {
        for b in &games[i + 1..] {
            let dup = |why: &str| Error::InvalidManifest {
                path: format!("{} / {}", a.slug, b.slug),
                reason: format!("duplicate game: {why}"),
            };
            if norm_repo(&a.source.repo) == norm_repo(&b.source.repo) {
                return Err(dup("same source repository"));
            }
            if a.artifact.sha256.eq_ignore_ascii_case(&b.artifact.sha256) {
                return Err(dup("same artifact hash"));
            }
            let declared = a.variant_of.as_deref() == Some(b.slug.as_str())
                || b.variant_of.as_deref() == Some(a.slug.as_str());
            if declared {
                continue;
            }
            if norm(&a.title) == norm(&b.title) {
                return Err(dup("same title (set variant_of if this is a deliberate variant)"));
            }
            let (wa, wb) = (words(&a.title), words(&b.title));
            let common = wa.intersection(&wb).count();
            let union = wa.union(&wb).count().max(1);
            let (na, nb) = (norm(&a.title), norm(&b.title));
            let contained = na.len().min(nb.len()) >= 5 && (na.contains(&nb) || nb.contains(&na));
            if contained || (common > 0 && common * 2 >= union) {
                warnings.push(format!(
                    "{} and {} have similar titles ({:?} / {:?}): check they are not the same game",
                    a.slug, b.slug, a.title, b.title
                ));
            }
        }
    }
    Ok(warnings)
}

impl Catalog {
    /// Reads, validates and filters against the blocklist. Any invalid or
    /// blocked manifest fails the build (CI rejects the PR).
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
        let warnings = check_duplicates(&games)?;
        Ok(Self { games, warnings })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn game(slug: &str, title: &str, repo: &str, sha: char) -> GameManifest {
        serde_json::from_value(serde_json::json!({
            "schema": 1, "slug": slug, "title": title, "authors": ["a"],
            "source": { "repo": repo, "commit": "abc" },
            "license": { "code": "MIT", "assets": "MIT" },
            "assets_policy": "open",
            "artifact": { "url": "https://x/y", "sha256": sha.to_string().repeat(64), "size": 1, "entry": "i.html" },
            "saves": { "paths": [], "version": 1 },
            "contact": "a@b.c"
        }))
        .unwrap()
    }

    #[test]
    fn distinct_games_pass_without_warnings() {
        let g = [game("doom", "Doom", "https://github.com/a/doom", 'a'), game("ttd", "OpenTTD", "https://github.com/b/ttd", 'b')];
        assert!(check_duplicates(&g).unwrap().is_empty());
    }

    #[test]
    fn same_repo_hash_or_title_is_rejected() {
        let a = game("a", "Alpha", "https://github.com/x/alpha", 'a');
        let same_repo = game("b", "Beta", "https://GitHub.com/X/Alpha.git/", 'b');
        assert!(check_duplicates(&[a.clone(), same_repo]).is_err());
        let same_hash = game("b", "Beta", "https://github.com/y/beta", 'a');
        assert!(check_duplicates(&[a.clone(), same_hash]).is_err());
        let same_title = game("b", "ALPHA!", "https://github.com/y/alpha2", 'b');
        assert!(check_duplicates(&[a, same_title]).is_err());
    }

    #[test]
    fn declared_variant_may_share_a_title() {
        let a = game("alpha", "Alpha", "https://github.com/x/alpha", 'a');
        let mut b = game("alpha-fork", "Alpha", "https://github.com/y/alpha", 'b');
        b.variant_of = Some("alpha".into());
        assert!(check_duplicates(&[a, b]).unwrap().is_empty());
    }

    #[test]
    fn similar_titles_warn() {
        let a = game("a", "Super Tux Kart", "https://github.com/x/a", 'a');
        let b = game("b", "SuperTux Kart Racing", "https://github.com/y/b", 'b');
        let w = check_duplicates(&[a, b]).unwrap();
        assert_eq!(w.len(), 1, "{w:?}");
    }
}
