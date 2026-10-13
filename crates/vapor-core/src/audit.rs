//! Static security audit of a game artifact (an extracted directory).
//!
//! A game is a bundle of web files plus data. Nothing in it needs to be a native
//! executable, a script for the host OS or an opaque installer, and nothing in it should
//! phone home. This module looks for exactly that:
//!
//! * native executables / installers / host scripts (by extension **and** by magic bytes),
//! * `.wasm` files that are not valid WebAssembly or import from unexpected modules,
//! * nested archives (inspected one level deep) hiding any of the above,
//! * files whose content does not match their extension (polyglots),
//! * JavaScript / HTML that mines coins, decodes-then-evals payloads, or talks to hosts.
//!
//! Findings are `Block` (the artifact must not be listed or installed) or `Warn` (a human
//! must review and accept the rule in `audits/<slug>.json`). It is a heuristic filter, not
//! an antivirus: it reduces the attack surface and forces a review, it does not prove
//! safety. At runtime the game window additionally has no Tauri IPC and a CSP that blocks
//! all network access (see `serve::GAME_CSP`).

use std::collections::BTreeSet;
use std::fs;
use std::io::{Cursor, Read};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::Result;

pub const TOOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warn,
    Block,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finding {
    pub severity: Severity,
    pub rule: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub detail: String,
}

impl Finding {
    /// `rule` or `rule:detail`; what a reviewer writes in `accepted` to sign a warning off.
    pub fn key(&self) -> String {
        if self.detail.is_empty() {
            self.rule.clone()
        } else {
            format!("{}:{}", self.rule, self.detail)
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Report {
    pub files: usize,
    pub bytes: u64,
    pub findings: Vec<Finding>,
}

impl Report {
    pub fn blocked(&self) -> bool {
        self.findings.iter().any(|f| f.severity == Severity::Block)
    }

    /// Warning rules a human still has to sign off (`accepted` holds `rule` or `rule:detail`).
    pub fn unaccepted_warnings(&self, accepted: &[String]) -> Vec<&Finding> {
        self.findings
            .iter()
            .filter(|f| f.severity == Severity::Warn)
            .filter(|f| !accepted.iter().any(|a| *a == f.rule || *a == f.key()))
            .collect()
    }

    fn push(&mut self, severity: Severity, rule: &str, path: &str, detail: impl Into<String>) {
        let f = Finding { severity, rule: rule.into(), path: path.into(), detail: detail.into() };
        if !self.findings.contains(&f) {
            self.findings.push(f);
        }
    }
}

/// Extensions of things that execute natively or install themselves.
const BLOCK_EXT: &[&str] = &[
    "exe", "dll", "sys", "scr", "com", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "wsf", "hta",
    "msi", "msix", "appx", "lnk", "pif", "cpl", "jar", "apk", "so", "dylib", "dmg", "pkg", "deb",
    "rpm", "app", "elf",
];
/// Host scripts: harmless inside a browser, but there is no reason to ship them.
const WARN_EXT: &[&str] = &["sh", "bash", "zsh", "py", "pl", "rb", "php", "ps", "reg"];

/// Modules a wasm binary may import from without review.
const WASM_OK_MODULES: &[&str] = &["env", "wasi_snapshot_preview1", "wasi_unstable", "a", "GOT.mem", "GOT.func"];

/// Hosts that appear in comments and namespaces of every Emscripten build.
const BENIGN_HOST_SUFFIXES: &[&str] = &[
    "w3.org", "emscripten.org", "mozilla.org", "khronos.org", "webassembly.org", "github.com",
    "githubusercontent.com", "wikipedia.org", "libsdl.org", "ietf.org", "whatwg.org", "gnu.org",
    "opensource.org", "creativecommons.org", "apache.org", "unicode.org", "example.com",
    "localhost", "stackoverflow.com", "llvm.org",
];

const BLOCK_JS: &[(&str, &str)] = &[
    ("coinhive", "crypto-miner"),
    ("coin-hive", "crypto-miner"),
    ("cryptonight", "crypto-miner"),
    ("authedmine", "crypto-miner"),
    ("minero.cc", "crypto-miner"),
    ("eval(atob(", "decode-then-eval"),
    ("Function(atob(", "decode-then-eval"),
    ("eval(unescape(", "decode-then-eval"),
    ("document.write(unescape(", "decode-then-eval"),
];

const WARN_JS: &[(&str, &str)] = &[
    ("new WebSocket(", "capability-websocket"),
    ("RTCPeerConnection", "capability-webrtc"),
    ("sendBeacon", "capability-beacon"),
    ("document.cookie", "capability-cookie"),
    ("getUserMedia", "capability-camera-mic"),
    ("navigator.clipboard", "capability-clipboard"),
    ("importScripts(", "capability-import-scripts"),
    ("new Function(", "dynamic-code"),
    ("eval(", "dynamic-code"),
    ("window.open(", "capability-popup"),
    ("location.href=", "capability-navigation"),
];

const MAX_SCAN_BYTES: u64 = 32 * 1024 * 1024;

fn ext(path: &str) -> String {
    Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// Native executable / installer / script signatures from the first bytes.
fn exec_magic(head: &[u8]) -> Option<&'static str> {
    match head {
        [b'M', b'Z', ..] => Some("windows-pe"),
        [0x7f, b'E', b'L', b'F', ..] => Some("elf"),
        [0xfe, 0xed, 0xfa, 0xce | 0xcf, ..] | [0xce | 0xcf, 0xfa, 0xed, 0xfe, ..] => Some("mach-o"),
        [b'#', b'!', ..] => Some("shebang-script"),
        [0xd0, 0xcf, 0x11, 0xe0, ..] => Some("ole2-installer-or-document"),
        _ => None,
    }
}

fn is_zip(head: &[u8]) -> bool {
    head.starts_with(b"PK\x03\x04")
}

fn opaque_archive(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"7z\xbc\xaf\x27\x1c") {
        Some("7z")
    } else if head.starts_with(b"Rar!") {
        Some("rar")
    } else if head.starts_with(&[0x1f, 0x8b]) {
        Some("gzip")
    } else if head.starts_with(b"\xfd7zXZ\0") {
        Some("xz")
    } else if head.starts_with(b"BZh") {
        Some("bzip2")
    } else {
        None
    }
}

/// Audits an extracted game directory.
pub fn audit_dir(root: &Path) -> Result<Report> {
    let mut report = Report::default();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut entries: Vec<_> = fs::read_dir(&dir)?.collect::<std::io::Result<_>>()?;
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let ft = e.file_type()?;
            let path = e.path();
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            if ft.is_symlink() {
                report.push(Severity::Block, "symlink", &rel, "");
            } else if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() {
                audit_file(&mut report, &path, &rel)?;
            }
        }
    }
    report.findings.sort_by(|a, b| {
        (std::cmp::Reverse(a.severity as u8), &a.path, &a.rule)
            .cmp(&(std::cmp::Reverse(b.severity as u8), &b.path, &b.rule))
    });
    Ok(report)
}

fn audit_file(report: &mut Report, abs: &Path, rel: &str) -> Result<()> {
    let len = fs::metadata(abs)?.len();
    report.files += 1;
    report.bytes += len;
    let ext = ext(rel);

    if BLOCK_EXT.contains(&ext.as_str()) {
        report.push(Severity::Block, "executable-extension", rel, format!(".{ext}"));
    } else if WARN_EXT.contains(&ext.as_str()) {
        report.push(Severity::Warn, "host-script", rel, format!(".{ext}"));
    }

    let mut head = [0u8; 16];
    let n = fs::File::open(abs)?.read(&mut head)?;
    let head = &head[..n];

    if ext != "wasm" {
        if let Some(kind) = exec_magic(head) {
            report.push(Severity::Block, "executable-content", rel, kind);
        }
    }
    if let Some(kind) = opaque_archive(head) {
        report.push(Severity::Warn, "opaque-archive", rel, kind);
    }
    if is_zip(head) {
        audit_nested_zip(report, abs, rel, len)?;
    }

    match ext.as_str() {
        "wasm" => audit_wasm(report, abs, rel)?,
        "png" if !head.starts_with(b"\x89PNG") => report.push(Severity::Warn, "extension-mismatch", rel, "png"),
        "jpg" | "jpeg" if !head.starts_with(&[0xff, 0xd8]) => {
            report.push(Severity::Warn, "extension-mismatch", rel, "jpeg")
        }
        "gif" if !head.starts_with(b"GIF8") => report.push(Severity::Warn, "extension-mismatch", rel, "gif"),
        "ogg" if !head.starts_with(b"OggS") => report.push(Severity::Warn, "extension-mismatch", rel, "ogg"),
        "js" | "mjs" | "html" | "htm" | "css" | "svg" => audit_text(report, abs, rel, len)?,
        _ => {}
    }
    Ok(())
}

fn audit_nested_zip(report: &mut Report, abs: &Path, rel: &str, len: u64) -> Result<()> {
    if len > 512 * 1024 * 1024 {
        report.push(Severity::Warn, "nested-archive-too-large", rel, "");
        return Ok(());
    }
    let bytes = fs::read(abs)?;
    let Ok(mut zip) = zip::ZipArchive::new(Cursor::new(&bytes[..])) else {
        report.push(Severity::Warn, "nested-archive-unreadable", rel, "");
        return Ok(());
    };
    report.push(Severity::Warn, "nested-archive", rel, format!("{} entries", zip.len()));
    for i in 0..zip.len().min(20_000) {
        let Ok(mut entry) = zip.by_index(i) else { continue };
        let name = entry.name().to_string();
        let inner = format!("{rel}!{name}");
        let e = ext(&name);
        if name.contains("..") || name.starts_with('/') || name.contains('\\') {
            report.push(Severity::Block, "nested-unsafe-path", &inner, "");
        }
        if BLOCK_EXT.contains(&e.as_str()) {
            report.push(Severity::Block, "executable-extension", &inner, format!(".{e}"));
        }
        let mut head = [0u8; 16];
        let n = entry.read(&mut head).unwrap_or(0);
        if let Some(kind) = exec_magic(&head[..n]) {
            report.push(Severity::Block, "executable-content", &inner, kind);
        }
    }
    Ok(())
}

fn leb(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let (mut result, mut shift) = (0u64, 0u32);
    loop {
        let b = *buf.get(*pos)?;
        *pos += 1;
        result |= u64::from(b & 0x7f).checked_shl(shift)?;
        if b & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
}

fn skip_limits(buf: &[u8], p: &mut usize) -> Option<()> {
    let flags = leb(buf, p)?;
    leb(buf, p)?;
    if flags & 1 != 0 {
        leb(buf, p)?;
    }
    Some(())
}

/// Module names in the import section, or `None` if the binary is malformed.
fn wasm_import_modules(buf: &[u8]) -> Option<BTreeSet<String>> {
    if buf.len() < 8 || &buf[..4] != b"\0asm" || buf[4..8] != [1, 0, 0, 0] {
        return None;
    }
    let mut modules = BTreeSet::new();
    let mut pos = 8usize;
    while pos < buf.len() {
        let id = *buf.get(pos)?;
        pos += 1;
        let size = leb(buf, &mut pos)? as usize;
        let end = pos.checked_add(size)?;
        if id == 2 {
            let mut p = pos;
            let count = leb(buf, &mut p)?;
            for _ in 0..count {
                let mlen = leb(buf, &mut p)? as usize;
                modules.insert(String::from_utf8_lossy(buf.get(p..p.checked_add(mlen)?)?).into_owned());
                p += mlen;
                let flen = leb(buf, &mut p)? as usize;
                p = p.checked_add(flen)?;
                let kind = *buf.get(p)?;
                p += 1;
                match kind {
                    0 => {
                        leb(buf, &mut p)?;
                    }
                    1 => {
                        p += 1; // reference type
                        skip_limits(buf, &mut p)?;
                    }
                    2 => skip_limits(buf, &mut p)?,
                    3 => p += 2, // value type + mutability
                    4 => {
                        p += 1; // attribute
                        leb(buf, &mut p)?;
                    }
                    _ => return None,
                }
            }
            return Some(modules);
        }
        pos = end;
    }
    Some(modules)
}

fn audit_wasm(report: &mut Report, abs: &Path, rel: &str) -> Result<()> {
    let mut buf = Vec::new();
    fs::File::open(abs)?.take(8 * 1024 * 1024).read_to_end(&mut buf)?;
    match wasm_import_modules(&buf) {
        None => report.push(Severity::Block, "wasm-malformed", rel, ""),
        Some(mods) => {
            for m in mods.iter().filter(|m| !WASM_OK_MODULES.contains(&m.as_str())) {
                report.push(Severity::Warn, "wasm-unexpected-import-module", rel, m.clone());
            }
        }
    }
    Ok(())
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let end = rest.find(|c: char| matches!(c, '/' | ':' | '?' | '#')).unwrap_or(rest.len());
    let host = rest[..end].to_ascii_lowercase();
    let valid = !host.is_empty()
        && host.len() < 254
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    valid.then_some(host)
}

fn audit_text(report: &mut Report, abs: &Path, rel: &str, len: u64) -> Result<()> {
    if len > MAX_SCAN_BYTES {
        report.push(Severity::Warn, "too-large-to-scan", rel, "");
        return Ok(());
    }
    let text = String::from_utf8_lossy(&fs::read(abs)?).into_owned();
    let lower = text.to_ascii_lowercase();
    for (needle, rule) in BLOCK_JS {
        if lower.contains(&needle.to_ascii_lowercase()) {
            report.push(Severity::Block, rule, rel, *needle);
        }
    }
    for (needle, rule) in WARN_JS {
        if text.contains(needle) {
            report.push(Severity::Warn, rule, rel, "");
        }
    }
    let mut hosts = BTreeSet::new();
    for scheme in ["http://", "https://", "ws://", "wss://"] {
        let mut from = 0;
        while let Some(i) = text[from..].find(scheme) {
            let start = from + i;
            let tail = &text[start..];
            let end = tail
                .find(|c: char| c.is_whitespace() || "\"'`<>)]}\\,;".contains(c))
                .unwrap_or(tail.len());
            if let Some(h) = host_of(&tail[..end]) {
                hosts.insert(h);
            }
            from = start + scheme.len();
        }
    }
    for h in hosts {
        let benign = BENIGN_HOST_SUFFIXES.iter().any(|s| h == *s || h.ends_with(&format!(".{s}")));
        if !benign {
            report.push(Severity::Warn, "external-host", rel, h);
        }
    }
    Ok(())
}

/// Signed-off result of auditing one artifact, stored as `audits/<slug>.json`. `validate`
/// refuses to list a game without a record that matches the manifest's artifact.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditRecord {
    pub slug: String,
    pub artifact_sha256: String,
    pub artifact_size: u64,
    pub tool_version: u32,
    /// `YYYY-MM-DD`.
    pub audited_at: String,
    pub files: usize,
    pub bytes: u64,
    pub findings: Vec<Finding>,
    /// Warning rules (`rule` or `rule:detail`) a human reviewed and accepted.
    #[serde(default)]
    pub accepted: Vec<String>,
    /// Why the accepted warnings are fine.
    #[serde(default)]
    pub notes: String,
}

impl AuditRecord {
    pub fn new(
        slug: &str,
        artifact_sha256: &str,
        artifact_size: u64,
        date: &str,
        report: Report,
        accepted: Vec<String>,
        notes: &str,
    ) -> Self {
        Self {
            slug: slug.into(),
            artifact_sha256: artifact_sha256.to_ascii_lowercase(),
            artifact_size,
            tool_version: TOOL_VERSION,
            audited_at: date.into(),
            files: report.files,
            bytes: report.bytes,
            findings: report.findings,
            accepted,
            notes: notes.into(),
        }
    }

    fn report(&self) -> Report {
        Report { files: self.files, bytes: self.bytes, findings: self.findings.clone() }
    }

    /// The record must describe exactly this manifest's artifact, come from the current
    /// tool, contain no blocking finding and have every warning accepted by a human.
    pub fn check(&self, m: &crate::manifest::GameManifest) -> Result<()> {
        let fail = |why: String| crate::Error::AuditFailed(format!("{}: {why}", m.slug));
        if self.slug != m.slug {
            return Err(fail("audit record is for another game".into()));
        }
        if !self.artifact_sha256.eq_ignore_ascii_case(&m.artifact.sha256) || self.artifact_size != m.artifact.size {
            return Err(fail("audit record does not match the artifact hash/size in game.json: re-audit".into()));
        }
        if self.tool_version < TOOL_VERSION {
            return Err(fail(format!("audit made by tool v{} < v{TOOL_VERSION}: re-audit", self.tool_version)));
        }
        let report = self.report();
        if report.blocked() {
            return Err(fail("blocking findings present".into()));
        }
        let open = report.unaccepted_warnings(&self.accepted);
        if !open.is_empty() {
            let list: Vec<_> = open.iter().map(|f| format!("{} ({})", f.key(), f.path)).collect();
            return Err(fail(format!("warnings not accepted by a reviewer: {}", list.join(", "))));
        }
        Ok(())
    }
}

/// Extracts a zip artifact into a scratch directory, audits it and cleans up.
pub fn audit_zip(bytes: &[u8]) -> Result<Report> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let dir = std::env::temp_dir().join(format!("vapor-audit-{}-{nanos}", std::process::id()));
    let result = crate::unpack::extract_zip(bytes, &dir.join("files"), &crate::unpack::Limits::default())
        .and_then(|_| audit_dir(&dir.join("files")));
    let _ = fs::remove_dir_all(&dir);
    result
}

/// `YYYY-MM-DD` (UTC) without a date dependency.
pub fn today() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    let z = secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn dir_with(files: &[(&str, &[u8])]) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for (name, data) in files {
            let p = d.path().join(name);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, data).unwrap();
        }
        d
    }

    fn rules(r: &Report) -> Vec<String> {
        r.findings.iter().map(|f| f.key()).collect()
    }

    const WASM_EMPTY: &[u8] = b"\0asm\x01\0\0\0";

    /// A wasm binary with one function import `f` from `module`.
    fn wasm_import(module: &str) -> Vec<u8> {
        let mut sec = vec![1u8, module.len() as u8];
        sec.extend(module.as_bytes());
        sec.extend([1, b'f', 0, 0]);
        let mut out = WASM_EMPTY.to_vec();
        out.push(2);
        out.push(sec.len() as u8);
        out.extend(sec);
        out
    }

    #[test]
    fn clean_web_game_passes() {
        let d = dir_with(&[
            ("index.html", b"<html><script src=\"game.js\"></script></html>"),
            ("game.js", b"console.log('hi'); // see https://emscripten.org/docs"),
            ("game.wasm", &wasm_import("env")),
            ("data/level.dat", &[1, 2, 3, 4]),
        ]);
        let r = audit_dir(d.path()).unwrap();
        assert!(r.findings.is_empty(), "{:?}", r.findings);
        assert_eq!(r.files, 4);
    }

    #[test]
    fn blocks_executables_by_extension_and_magic() {
        let d = dir_with(&[
            ("setup.exe", b"whatever"),
            ("renamed.dat", b"MZ\x90\0payload"),
            ("tool.dat", b"\x7fELF\x02\x01"),
            ("run.txt", b"#!/bin/sh\nrm -rf /"),
            ("mac.dat", &[0xcf, 0xfa, 0xed, 0xfe, 0, 0]),
        ]);
        let r = audit_dir(d.path()).unwrap();
        assert!(r.blocked());
        let k = rules(&r);
        assert!(k.contains(&"executable-extension:.exe".into()));
        for kind in ["windows-pe", "elf", "shebang-script", "mach-o"] {
            assert!(k.contains(&format!("executable-content:{kind}")), "{kind}: {k:?}");
        }
    }

    #[test]
    fn wasm_must_be_valid_and_imports_reviewed() {
        let d = dir_with(&[("a.wasm", b"not wasm at all")]);
        let r = audit_dir(d.path()).unwrap();
        assert!(rules(&r).contains(&"wasm-malformed".into()));
        assert!(r.blocked());

        let d = dir_with(&[("b.wasm", &wasm_import("evil_host"))]);
        let r = audit_dir(d.path()).unwrap();
        assert!(rules(&r).contains(&"wasm-unexpected-import-module:evil_host".into()));
        assert!(!r.blocked(), "unexpected import is a warning, not a block");
        assert_eq!(r.unaccepted_warnings(&[]).len(), 1);
        assert!(r.unaccepted_warnings(&["wasm-unexpected-import-module".into()]).is_empty());
        assert!(r.unaccepted_warnings(&["wasm-unexpected-import-module:evil_host".into()]).is_empty());
    }

    #[test]
    fn nested_archives_are_inspected() {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let o = zip::write::SimpleFileOptions::default();
        w.start_file("data/ok.txt", o).unwrap();
        w.write_all(b"fine").unwrap();
        w.start_file("evil.exe", o).unwrap();
        w.write_all(b"MZ").unwrap();
        let zipped = w.finish().unwrap().into_inner();
        let d = dir_with(&[("pack.pk3", &zipped)]);
        let r = audit_dir(d.path()).unwrap();
        assert!(rules(&r).contains(&"executable-extension:.exe".into()));
        assert!(r.findings.iter().any(|f| f.path == "pack.pk3!evil.exe"));
        assert!(rules(&r).iter().any(|x| x.starts_with("nested-archive")));
    }

    #[test]
    fn js_and_html_heuristics() {
        let d = dir_with(&[
            ("miner.js", b"var m = new CoinHive.Anonymous('x');"),
            ("loader.js", b"eval(atob('ZG9pdA=='))"),
            ("net.js", b"var s = new WebSocket('wss://relay.example.org/x'); fetch('https://cdn.tracker.io/a.js')"),
        ]);
        let r = audit_dir(d.path()).unwrap();
        let k = rules(&r);
        assert!(k.contains(&"crypto-miner:coinhive".into()), "{k:?}");
        assert!(k.contains(&"decode-then-eval:eval(atob(".into()));
        assert!(k.contains(&"capability-websocket".into()));
        assert!(k.contains(&"external-host:relay.example.org".into()));
        assert!(k.contains(&"external-host:cdn.tracker.io".into()));
        assert!(r.blocked());
    }

    #[test]
    fn extension_mismatch_and_opaque_archives_warn() {
        let d = dir_with(&[("pic.png", b"<script>"), ("blob.dat", b"7z\xbc\xaf\x27\x1c\0\0")]);
        let r = audit_dir(d.path()).unwrap();
        let k = rules(&r);
        assert!(k.contains(&"extension-mismatch:png".into()));
        assert!(k.contains(&"opaque-archive:7z".into()));
        assert!(!r.blocked());
    }

    fn manifest(sha: &str, size: u64) -> crate::manifest::GameManifest {
        serde_json::from_value(serde_json::json!({
            "schema": 1, "slug": "g", "title": "G", "authors": ["a"],
            "source": { "repo": "https://github.com/a/g", "commit": "abc" },
            "license": { "code": "MIT", "assets": "MIT" }, "assets_policy": "open",
            "artifact": { "url": "https://x", "sha256": sha, "size": size, "entry": "i.html" },
            "saves": { "paths": [], "version": 1 }, "contact": "a@b.c"
        }))
        .unwrap()
    }

    #[test]
    fn record_must_match_artifact_and_have_no_open_findings() {
        let sha = "a".repeat(64);
        let m = manifest(&sha, 10);
        let clean = AuditRecord::new("g", &sha, 10, "2026-10-13", Report::default(), vec![], "");
        assert!(clean.check(&m).is_ok());
        assert!(clean.check(&manifest(&"b".repeat(64), 10)).is_err(), "other hash");
        assert!(clean.check(&manifest(&sha, 11)).is_err(), "other size");

        let warn = Report {
            findings: vec![Finding { severity: Severity::Warn, rule: "capability-websocket".into(), path: "a.js".into(), detail: String::new() }],
            ..Report::default()
        };
        let r = AuditRecord::new("g", &sha, 10, "2026-10-13", warn.clone(), vec![], "");
        assert!(r.check(&m).is_err(), "unaccepted warning");
        let r = AuditRecord::new("g", &sha, 10, "2026-10-13", warn, vec!["capability-websocket".into()], "multiplayer");
        assert!(r.check(&m).is_ok());

        let block = Report {
            findings: vec![Finding { severity: Severity::Block, rule: "executable-content".into(), path: "x".into(), detail: "elf".into() }],
            ..Report::default()
        };
        let r = AuditRecord::new("g", &sha, 10, "2026-10-13", block, vec!["executable-content".into()], "");
        assert!(r.check(&m).is_err(), "blocks cannot be accepted away");
    }

    #[test]
    fn audit_zip_scans_and_cleans_up() {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let o = zip::write::SimpleFileOptions::default();
        w.start_file("g/index.html", o).unwrap();
        w.write_all(b"<html></html>").unwrap();
        w.start_file("g/payload.exe", o).unwrap();
        w.write_all(b"MZ").unwrap();
        let bytes = w.finish().unwrap().into_inner();
        let r = audit_zip(&bytes).unwrap();
        assert!(r.blocked());
        assert_eq!(r.files, 2);
    }

    #[test]
    fn today_looks_like_a_date() {
        let d = today();
        assert_eq!(d.len(), 10);
        assert!(d.starts_with("20"));
    }
}
