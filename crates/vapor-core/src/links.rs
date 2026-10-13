//! External, link-only entries: projects Vapor cannot (or must not) host or run, such as native
//! ports of commercial games. Vapor lists them, always links the original source, shows a legal
//! note, and hides the entry when the source stops being reachable. It never downloads, installs
//! or executes anything for them.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{Error, Result};

pub const SCHEMA_VERSION: u32 = 1;

/// Hosts a link may point to. Only a repository page: `https://<host>/<owner>/<repo>`.
pub const ALLOWED_HOSTS: &[&str] = &["github.com", "gitlab.com", "codeberg.org"];
pub const PLATFORMS: &[&str] = &["windows", "linux", "macos", "android", "web", "other"];

/// Result of the periodic liveness check (`tools/links/check.mjs`), merged in by `vapor index`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LinkStatus {
    /// `alive`, `archived`, `stale` (no push for a long time), `unknown` (check failed, will
    /// retry), `gone` (404 or repository disabled) or `blocked` (451: removed for legal reasons).
    pub state: String,
    pub checked_at: String,
    #[serde(default)]
    pub pushed_at: Option<String>,
    #[serde(default)]
    pub latest_release: Option<String>,
    /// Consecutive failed checks; an entry is hidden only after several, or at once for
    /// `gone`/`blocked`.
    #[serde(default)]
    pub failures: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExternalEntry {
    pub schema: u32,
    pub slug: String,
    pub title: String,
    /// Publisher of the original game, e.g. "Sony Interactive Entertainment".
    pub publisher: String,
    /// The original source page (repository). Always shown to the player.
    pub url: String,
    pub platforms: Vec<String>,
    /// What the player needs, in plain words (e.g. "A copy of the original game").
    pub requires: String,
    pub summary: String,
    /// Mandatory disclosure shown next to the entry (unofficial, derived from proprietary code,
    /// not hosted or endorsed by Vapor...).
    pub legal_note: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<LinkStatus>,
}

fn valid_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && !s.starts_with('-')
        && !s.ends_with('-')
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `(host, owner/repo)` of a repository URL, or `None` if it is not exactly that shape.
pub fn parse_repo_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("https://")?;
    let mut parts = rest.trim_end_matches('/').split('/');
    let host = parts.next()?.to_ascii_lowercase();
    let (owner, repo) = (parts.next()?, parts.next()?);
    let ok = |s: &str| {
        !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    if parts.next().is_some() || !ok(owner) || !ok(repo) || !ALLOWED_HOSTS.contains(&host.as_str()) {
        return None;
    }
    Some((host, format!("{owner}/{repo}")))
}

impl ExternalEntry {
    pub fn validate(&self, dir_slug: &str) -> Result<()> {
        let bad = |reason: &str| Error::InvalidManifest { path: format!("links/{dir_slug}"), reason: reason.into() };
        if self.schema != SCHEMA_VERSION {
            return Err(bad("unsupported schema"));
        }
        if !valid_slug(&self.slug) || self.slug != dir_slug {
            return Err(bad("slug must be [a-z0-9-] and equal the file name"));
        }
        if self.title.trim().is_empty() || self.publisher.trim().is_empty() {
            return Err(bad("title and publisher are required"));
        }
        if parse_repo_url(&self.url).is_none() {
            return Err(bad("url must be a repository page on github.com, gitlab.com or codeberg.org (https://host/owner/repo)"));
        }
        if self.platforms.is_empty() || self.platforms.iter().any(|p| !PLATFORMS.contains(&p.as_str())) {
            return Err(bad("platforms must be a non-empty list of windows/linux/macos/android/web/other"));
        }
        if self.requires.trim().is_empty() || self.summary.trim().is_empty() || self.summary.len() > 300 {
            return Err(bad("requires and summary are required (summary up to 300 chars)"));
        }
        if self.legal_note.trim().len() < 20 {
            return Err(bad("legal_note is mandatory: say it is unofficial and not hosted or endorsed by Vapor"));
        }
        Ok(())
    }

    /// Normalized `host/owner/repo`, to detect the same project listed twice.
    pub fn repo_key(&self) -> String {
        parse_repo_url(&self.url).map_or_else(String::new, |(h, r)| format!("{h}/{}", r.to_lowercase()))
    }

    /// Hidden once the source is gone or blocked, or after repeated failed checks.
    pub fn visible(&self) -> bool {
        match &self.status {
            None => true,
            Some(s) => !(matches!(s.state.as_str(), "gone" | "blocked") || (s.state == "unknown" && s.failures >= 3)),
        }
    }
}

/// Reads `links/*.json` (missing directory = no links).
pub fn load_dir(dir: &Path) -> Result<Vec<ExternalEntry>> {
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let slug = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let e: ExternalEntry = serde_json::from_slice(&std::fs::read(&path)?)?;
        e.validate(&slug)?;
        out.push(e);
    }
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(out)
}

/// Merges liveness results (slug -> status) into the entries.
pub fn apply_status(entries: &mut [ExternalEntry], statuses: &HashMap<String, LinkStatus>) {
    for e in entries {
        if let Some(s) = statuses.get(&e.slug) {
            e.status = Some(s.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> ExternalEntry {
        ExternalEntry {
            schema: 1,
            slug: "some-port".into(),
            title: "Some Port".into(),
            publisher: "Some Publisher".into(),
            url: "https://github.com/owner/some-port".into(),
            platforms: vec!["windows".into(), "linux".into()],
            requires: "A copy of the original game".into(),
            summary: "Unofficial native port.".into(),
            legal_note: "Unofficial; derived from proprietary code; not hosted or endorsed by Vapor.".into(),
            tags: vec![],
            status: None,
        }
    }

    #[test]
    fn valid_entry_passes_and_bad_ones_fail() {
        assert!(entry().validate("some-port").is_ok());
        assert!(entry().validate("other").is_err(), "slug must match the file name");
        for url in [
            "http://github.com/o/r",
            "https://evil.example/o/r",
            "https://github.com/o",
            "https://github.com/o/r/releases/download/x.zip",
            "https://github.com/o/r/blob/main/file",
            "https://almost-there-games.itch.io/azimuth",
            "https://github.com.evil.example/o/r",
        ] {
            let mut e = entry();
            e.url = url.into();
            assert!(e.validate("some-port").is_err(), "{url}");
        }
        let mut e = entry();
        e.legal_note = "ok".into();
        assert!(e.validate("some-port").is_err(), "legal note is mandatory");
        let mut e = entry();
        e.platforms = vec!["playstation".into()];
        assert!(e.validate("some-port").is_err());
    }

    #[test]
    fn repo_key_ignores_case_and_trailing_slash() {
        let mut a = entry();
        a.url = "https://GitHub.com/Owner/Some-Port/".into();
        assert_eq!(a.repo_key(), entry().repo_key());
    }

    #[test]
    fn dead_sources_are_hidden() {
        let mut e = entry();
        assert!(e.visible(), "unchecked entries show up");
        let st = |state: &str, failures| LinkStatus { state: state.into(), checked_at: "2026-10-13T00:00:00Z".into(), pushed_at: None, latest_release: None, failures };
        for (state, failures, visible) in [("alive", 0, true), ("archived", 0, true), ("stale", 0, true), ("unknown", 2, true), ("unknown", 3, false), ("gone", 1, false), ("blocked", 1, false)] {
            e.status = Some(st(state, failures));
            assert_eq!(e.visible(), visible, "{state}/{failures}");
        }
    }

    #[test]
    fn status_is_merged_by_slug() {
        let mut es = vec![entry()];
        let mut m = HashMap::new();
        m.insert("some-port".to_string(), LinkStatus { state: "alive".into(), checked_at: "t".into(), pushed_at: None, latest_release: Some("v1".into()), failures: 0 });
        apply_status(&mut es, &m);
        assert_eq!(es[0].status.as_ref().unwrap().latest_release.as_deref(), Some("v1"));
    }
}
