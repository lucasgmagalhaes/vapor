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

/// A native build a maintainer has reviewed and pinned. "Verified" here means exactly this and
/// nothing more: the file is one specific release asset of the linked repository, its size and
/// SHA-256 were recorded by a named reviewer on a date, and the app re-checks both before every
/// run. It is NOT a statement that the program is safe, and Vapor cannot sandbox native code.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NativeBuild {
    /// `windows` or `linux`.
    pub platform: String,
    /// Release asset URL; must live under `https://github.com/<owner>/<repo>/releases/download/`
    /// of the same repository as the entry's `url`.
    pub url: String,
    pub sha256: String,
    pub size: u64,
    /// Program to start: the asset itself (a plain executable/AppImage: use its file name) or a
    /// relative path inside the `.zip` asset.
    pub exe: String,
    pub reviewed_by: String,
    /// `YYYY-MM-DD`.
    pub reviewed_on: String,
    /// What stands behind the build: `reviewed` (a named person looked at it) or `scanned` (only
    /// the automatic pipeline: hash pinned and antivirus-scanned in a throwaway CI runner). The
    /// app shows the difference and asks for an explicit confirmation either way.
    #[serde(default = "default_trust")]
    pub trust: String,
    #[serde(default)]
    pub notes: String,
}

fn default_trust() -> String {
    "scanned".into()
}

/// Largest native asset the app will download (the Linux AppImages seen are up to ~900 MB).
pub const MAX_NATIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

fn safe_rel_path(p: &str) -> bool {
    !p.is_empty()
        && !p.starts_with('/')
        && !p.contains(['\\', '\0', ':'])
        && p.split('/').all(|c| !c.is_empty() && c != "." && c != "..")
}

fn valid_date(d: &str) -> bool {
    d.len() == 10
        && d.char_indices().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() })
}

impl NativeBuild {
    fn validate(&self, entry_repo: &str) -> std::result::Result<(), String> {
        if !matches!(self.platform.as_str(), "windows" | "linux") {
            return Err("native.platform must be windows or linux".into());
        }
        let prefix = format!("https://github.com/{entry_repo}/releases/download/");
        if !self.url.to_ascii_lowercase().starts_with(&prefix.to_ascii_lowercase()) || self.url.contains(['?', '#']) {
            return Err(format!("native.url must be a release asset of {entry_repo} (…/releases/download/<tag>/<file>)"));
        }
        if self.sha256.len() != 64 || !self.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("native.sha256 must be 64 hex chars".into());
        }
        if self.size == 0 || self.size > MAX_NATIVE_BYTES {
            return Err("native.size must be between 1 byte and 2 GiB".into());
        }
        if !safe_rel_path(&self.exe) {
            return Err("native.exe must be a relative path without .., backslashes or drive letters".into());
        }
        if !matches!(self.trust.as_str(), "reviewed" | "scanned") {
            return Err("native.trust must be reviewed or scanned".into());
        }
        if self.reviewed_by.trim().is_empty() || !valid_date(&self.reviewed_on) {
            return Err("native.reviewed_by and native.reviewed_on (YYYY-MM-DD) are required".into());
        }
        Ok(())
    }

    /// File name of the downloaded asset.
    pub fn asset_name(&self) -> &str {
        self.url.rsplit('/').next().unwrap_or("")
    }

    pub fn is_zip(&self) -> bool {
        self.asset_name().to_ascii_lowercase().ends_with(".zip")
    }
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
    /// Entries of the same game for different systems share a `group`; the app shows ONE card per
    /// group and picks the variant that fits the player's system.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// Short label of this variant inside its group (e.g. "Windows port (author)").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    /// Public URL of `covers/<group or slug>.webp`, set by `vapor index` only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    /// Reviewed native builds the app may run (see `NativeBuild`). Empty = link only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub native: Vec<NativeBuild>,
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
        if self.cover.is_some() {
            return Err(bad("cover is set by `vapor index`; add covers/<group or slug>.webp instead"));
        }
        match (&self.group, &self.variant) {
            (None, None) => {}
            (Some(g), Some(v)) if valid_slug(g) && !v.trim().is_empty() => {}
            _ => return Err(bad("group (a slug) and variant (a label) must be set together")),
        }
        if let Some((host, repo)) = parse_repo_url(&self.url) {
            for n in &self.native {
                if host != "github.com" {
                    return Err(bad("native builds are only supported for github.com repositories"));
                }
                n.validate(&repo).map_err(|e| bad(&e))?;
            }
        }
        Ok(())
    }

    /// Normalized `host/owner/repo`, to detect the same project listed twice.
    pub fn repo_key(&self) -> String {
        parse_repo_url(&self.url).map_or_else(String::new, |(h, r)| format!("{h}/{}", r.to_lowercase()))
    }

    /// Key of this entry's cover: the group of its game when it has one, else its slug.
    pub fn cover_key(&self) -> &str {
        self.group.as_deref().unwrap_or(&self.slug)
    }

    /// The reviewed build for `platform` (`windows`/`linux`), if any.
    pub fn native_for(&self, platform: &str) -> Option<&NativeBuild> {
        self.native.iter().find(|n| n.platform == platform)
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
            group: None,
            variant: None,
            cover: None,
            native: vec![],
            status: None,
        }
    }

    #[test]
    fn group_and_variant_go_together() {
        let mut e = entry();
        e.group = Some("some-game".into());
        assert!(e.validate("some-port").is_err(), "group without variant");
        e.variant = Some("Windows port".into());
        assert!(e.validate("some-port").is_ok());
        e.group = Some("Bad Group".into());
        assert!(e.validate("some-port").is_err(), "group must be a slug");
        let mut only_variant = entry();
        only_variant.variant = Some("x".into());
        assert!(only_variant.validate("some-port").is_err());
    }

    fn build() -> NativeBuild {
        NativeBuild {
            platform: "windows".into(),
            url: "https://github.com/owner/some-port/releases/download/v1/game.zip".into(),
            sha256: "a".repeat(64),
            size: 1000,
            exe: "game/run.exe".into(),
            reviewed_by: "maintainer".into(),
            reviewed_on: "2026-10-13".into(),
            trust: "reviewed".into(),
            notes: String::new(),
        }
    }

    #[test]
    fn native_builds_must_be_pinned_assets_of_the_same_repository() {
        let mut e = entry();
        e.native = vec![build()];
        assert!(e.validate("some-port").is_ok());
        assert_eq!(e.native_for("windows").unwrap().asset_name(), "game.zip");
        assert!(e.native_for("linux").is_none());

        let bad = |f: &dyn Fn(&mut NativeBuild)| {
            let mut e = entry();
            let mut b = build();
            f(&mut b);
            e.native = vec![b];
            e.validate("some-port").is_err()
        };
        assert!(bad(&|b| b.url = "https://github.com/other/repo/releases/download/v1/game.zip".into()), "other repo");
        assert!(bad(&|b| b.url = "https://evil.example/owner/some-port/releases/download/v1/g.zip".into()), "other host");
        assert!(bad(&|b| b.url = "https://github.com/owner/some-port/archive/main.zip".into()), "not a release asset");
        assert!(bad(&|b| b.url = "https://github.com/owner/some-port/releases/download/v1/g.zip?x=1".into()), "query string");
        assert!(bad(&|b| b.sha256 = "zz".into()));
        assert!(bad(&|b| b.size = 0));
        assert!(bad(&|b| b.size = MAX_NATIVE_BYTES + 1));
        assert!(bad(&|b| b.platform = "macos".into()));
        assert!(bad(&|b| b.exe = "../run.exe".into()));
        assert!(bad(&|b| b.exe = "C:/run.exe".into()));
        assert!(bad(&|b| b.exe = "a\\b.exe".into()));
        assert!(bad(&|b| b.reviewed_by = " ".into()), "a named reviewer is required");
        assert!(bad(&|b| b.reviewed_on = "yesterday".into()));
        assert!(bad(&|b| b.trust = "trusted".into()), "only reviewed or scanned");
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
