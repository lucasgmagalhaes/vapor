use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::blocklist::Blocklist;
use crate::links::{self, ExternalEntry};
use crate::manifest::GameManifest;
use crate::{Error, Result};

/// Index built from `games/*/game.json`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Catalog {
    pub games: Vec<GameManifest>,
    /// Link-only entries (`links/*.json`): listed with their original source, never run.
    #[serde(default)]
    pub links: Vec<ExternalEntry>,
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

/// A link-only entry may not repeat a game Vapor already runs, or another link.
fn check_link_duplicates(games: &[GameManifest], links: &[ExternalEntry]) -> Result<()> {
    for (i, l) in links.iter().enumerate() {
        let dup = |why: String| Error::InvalidManifest { path: format!("links/{}", l.slug), reason: format!("duplicate: {why}") };
        for g in games {
            if g.slug == l.slug {
                return Err(dup(format!("same slug as game {}", g.slug)));
            }
            let gk = norm_repo(&g.source.repo);
            if l.repo_key() == gk {
                return Err(dup(format!("same source repository as game {}", g.slug)));
            }
        }
        for o in &links[i + 1..] {
            if o.repo_key() == l.repo_key() {
                return Err(dup(format!("same source repository as links/{}", o.slug)));
            }
            if o.slug == l.slug {
                return Err(dup("same slug".into()));
            }
        }
    }
    Ok(())
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
        let mut links = match games_dir.parent() {
            Some(root) => links::load_dir(&root.join("links"))?,
            None => Vec::new(),
        };
        for l in &links {
            if let Some(reference) = blocklist.check_link(l) {
                return Err(Error::Blocked(format!("links/{} ({reference})", l.slug)));
            }
        }
        check_link_duplicates(&games, &links)?;
        links.sort_by(|a, b| a.slug.cmp(&b.slug));
        Ok(Self { games, links, warnings })
    }

    /// Re-validates a catalog received over the network (or read back from disk) with the same
    /// rules CI applies, dropping what fails. Returns the clean catalog and one line per drop.
    /// The app calls this on every download and every read: it never trusts the catalog branch.
    pub fn sanitized(self) -> (Self, Vec<String>) {
        let mut dropped = Vec::new();
        let games: Vec<_> = self
            .games
            .into_iter()
            .filter(|g| match g.validate(&g.slug) {
                Ok(()) => true,
                Err(e) => {
                    dropped.push(format!("game {}: {e}", g.slug));
                    false
                }
            })
            .collect();
        let links: Vec<_> = self
            .links
            .into_iter()
            .filter(|l| match l.validate(&l.slug) {
                Ok(()) => true,
                Err(e) => {
                    dropped.push(format!("link {}: {e}", l.slug));
                    false
                }
            })
            .collect();
        (Self { games, links, warnings: self.warnings }, dropped)
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

    fn link(slug: &str, url: &str) -> ExternalEntry {
        serde_json::from_value(serde_json::json!({
            "schema": 1, "slug": slug, "title": "T", "publisher": "P", "url": url,
            "platforms": ["windows"], "requires": "A copy of the original game", "summary": "s",
            "legal_note": "Unofficial; not hosted or endorsed by Vapor."
        }))
        .unwrap()
    }

    #[test]
    fn sanitized_drops_entries_that_fail_validation() {
        let mut ok = game("ok-game", "Ok", "https://github.com/a/ok", 'a');
        ok.artifact.url = format!("{}t-1/ok-game.zip", crate::manifest::ARTIFACT_URL_PREFIX);
        let mut evil_url = game("evil-url", "Evil", "https://github.com/a/evil", 'b');
        evil_url.artifact.url = "https://evil.example/payload.zip".into();
        let mut evil_repo = game("evil-repo", "Evil2", "javascript:alert(1)", 'c');
        evil_repo.artifact.url = format!("{}t-1/x.zip", crate::manifest::ARTIFACT_URL_PREFIX);
        let good_link = link("good-link", "https://github.com/b/good");
        let bad_link = link("bad-link", "https://evil.example/o/r");
        let cat = Catalog { games: vec![ok, evil_url, evil_repo], links: vec![good_link, bad_link], warnings: vec![] };
        let (clean, dropped) = cat.sanitized();
        assert_eq!(clean.games.iter().map(|g| g.slug.as_str()).collect::<Vec<_>>(), ["ok-game"]);
        assert_eq!(clean.links.iter().map(|l| l.slug.as_str()).collect::<Vec<_>>(), ["good-link"]);
        assert_eq!(dropped.len(), 3, "{dropped:?}");
    }

    #[test]
    fn links_cannot_repeat_games_or_each_other() {
        let g = game("doom", "Doom", "https://github.com/a/doom", 'a');
        assert!(check_link_duplicates(&[g.clone()], &[link("x", "https://github.com/b/x")]).is_ok());
        assert!(check_link_duplicates(&[g.clone()], &[link("y", "https://GitHub.com/A/Doom/")]).is_err(), "same repo as a game");
        assert!(check_link_duplicates(&[g], &[link("doom", "https://github.com/b/other")]).is_err(), "same slug as a game");
        assert!(check_link_duplicates(&[], &[link("a", "https://github.com/b/x"), link("b", "https://github.com/B/X")]).is_err());
    }

    #[test]
    fn blocklist_removes_links_by_slug_or_repository() {
        use crate::blocklist::{BlockEntry, Blocklist};
        let b = |slug: Option<&str>, domain: Option<&str>| Blocklist {
            entries: vec![BlockEntry { slug: slug.map(Into::into), sha256: None, domain: domain.map(Into::into), date: "2026-01-01".into(), reference: "r".into() }],
        };
        let l = link("x", "https://github.com/owner/x");
        assert!(b(Some("x"), None).check_link(&l).is_some());
        assert!(b(None, Some("github.com/owner")).check_link(&l).is_some(), "whole owner");
        assert!(b(None, Some("github.com/owner/x")).check_link(&l).is_some(), "exact repo");
        assert!(b(None, Some("github.com")).check_link(&l).is_none(), "never block a whole host by accident");
        assert!(b(None, Some("github.com/owne")).check_link(&l).is_none());
    }
}
