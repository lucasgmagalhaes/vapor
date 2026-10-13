//! `vapor validate` / `vapor index` / `vapor audit`: used by CI and contributors.
//!
//! * `vapor validate [root]`: manifests, blocklist, duplicates and, for every listed game,
//!   a matching `audits/<slug>.json` with no blocking finding and every warning accepted.
//! * `vapor index [root]`: writes `catalog.json`.
//! * `vapor audit <artifact.zip> --slug <slug> [--accept r1,r2] [--notes "why"] [--write]
//!   [--root <repo>]`: audits a built artifact; with `--write` stores `audits/<slug>.json`.
//!   Without `--write` it compares against the existing record (CI uses this to catch a
//!   record that no longer matches the artifact). `--scan-only` just fails on blocking
//!   findings (used by the artifact build workflows, before any record exists).

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use sha2::{Digest, Sha256};
use vapor_core::audit::{self, AuditRecord, Severity};
use vapor_core::blocklist::Blocklist;
use vapor_core::catalog::Catalog;

fn build_catalog(root: &Path) -> vapor_core::Result<Catalog> {
    let block = Blocklist::load(&root.join("takedown/blocklist.json"))?;
    Catalog::build(&root.join("games"), &block)
}

/// Every listed game needs a matching, clean, reviewed audit record.
fn check_audits(root: &Path, catalog: &Catalog) -> Result<(), String> {
    let mut errors = Vec::new();
    for g in &catalog.games {
        let path = root.join("audits").join(format!("{}.json", g.slug));
        let record: Result<AuditRecord, String> = std::fs::read(&path)
            .map_err(|_| format!("{}: missing audits/{}.json (run `vapor audit`)", g.slug, g.slug))
            .and_then(|b| serde_json::from_slice(&b).map_err(|e| format!("{}: bad audit record: {e}", g.slug)));
        match record {
            Ok(r) => {
                if let Err(e) = r.check(g) {
                    errors.push(e.to_string());
                }
            }
            Err(e) => errors.push(e),
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn cmd_audit(args: &[String]) -> ExitCode {
    let (Some(zip_path), Some(slug)) = (args.first().filter(|a| !a.starts_with("--")), flag(args, "--slug")) else {
        eprintln!("usage: vapor audit <artifact.zip> --slug <slug> [--accept r1,r2] [--notes \"why\"] [--write] [--root <repo>]");
        return ExitCode::from(2);
    };
    let root = PathBuf::from(flag(args, "--root").unwrap_or_else(|| ".".into()));
    let accepted: Vec<String> = flag(args, "--accept")
        .map(|s| s.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect())
        .unwrap_or_default();
    let notes = flag(args, "--notes").unwrap_or_default();

    let bytes = match std::fs::read(zip_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("error: {zip_path}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let sha = hex::encode(Sha256::digest(&bytes));
    let report = match audit::audit_zip(&bytes) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: artifact rejected: {e}");
            return ExitCode::FAILURE;
        }
    };

    println!("artifact: {zip_path}\nsha256:   {sha}\nsize:     {}\nfiles:    {} ({} bytes)", bytes.len(), report.files, report.bytes);
    for f in &report.findings {
        let tag = if f.severity == Severity::Block { "BLOCK" } else { "warn " };
        let accepted_mark = if f.severity == Severity::Warn && accepted.iter().any(|a| *a == f.rule || *a == f.key()) { " (accepted)" } else { "" };
        println!("  {tag} {} [{}]{}", f.key(), f.path, accepted_mark);
    }
    if report.blocked() {
        eprintln!("\nFAIL: blocking findings. This artifact must not be listed or installed.");
        return ExitCode::FAILURE;
    }
    if args.iter().any(|a| a == "--scan-only") {
        println!("
ok: no blocking findings (scan only; no record checked)");
        return ExitCode::SUCCESS;
    }
    let open = report.unaccepted_warnings(&accepted).len();
    let record = AuditRecord::new(&slug, &sha, bytes.len() as u64, &audit::today(), report, accepted, &notes);

    if args.iter().any(|a| a == "--write") {
        if open > 0 {
            eprintln!("\nFAIL: {open} warning(s) need a human decision. Review them, then pass --accept <rule,...> --notes \"why\".");
            return ExitCode::FAILURE;
        }
        let path = root.join("audits").join(format!("{slug}.json"));
        std::fs::create_dir_all(path.parent().expect("parent")).expect("create audits/");
        std::fs::write(&path, serde_json::to_vec_pretty(&record).expect("serialize")).expect("write record");
        println!("\nwrote {}", path.display());
        return ExitCode::SUCCESS;
    }

    // Verify mode: the stored record must describe this very artifact and findings.
    let path = root.join("audits").join(format!("{slug}.json"));
    let stored: AuditRecord = match std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()) {
        Some(r) => r,
        None => {
            eprintln!("\nFAIL: no readable {}", path.display());
            return ExitCode::FAILURE;
        }
    };
    let same = stored.artifact_sha256 == record.artifact_sha256
        && stored.artifact_size == record.artifact_size
        && stored.findings == record.findings;
    if !same {
        eprintln!("\nFAIL: {} does not match this artifact (hash, size or findings differ): re-audit with --write", path.display());
        return ExitCode::FAILURE;
    }
    println!("\nok: matches {}", path.display());
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().cloned().unwrap_or_default();
    if cmd == "audit" {
        return cmd_audit(&args[1..]);
    }
    let root = PathBuf::from(args.get(1).cloned().unwrap_or_else(|| ".".into()));
    let result = build_catalog(&root);
    match (cmd.as_str(), result) {
        ("validate", Ok(c)) => {
            for w in &c.warnings {
                eprintln!("warning: {w}");
            }
            if let Err(e) = check_audits(&root, &c) {
                eprintln!("error: {e}");
                return ExitCode::FAILURE;
            }
            if let Err(e) = vapor_core::covers::check_dir(&root.join("covers"), &c.cover_keys()) {
                eprintln!("error: {e}");
                return ExitCode::FAILURE;
            }
            println!("ok: {} valid, audited game(s)", c.games.len());
            ExitCode::SUCCESS
        }
        ("index", Ok(mut c)) => {
            // Liveness of the link-only entries (written by tools/links/check.mjs): merge it,
            // then drop entries whose original source is gone or blocked.
            let status_path = root.join("links-status.json");
            if let Some(statuses) = std::fs::read(&status_path)
                .ok()
                .and_then(|b| serde_json::from_slice::<std::collections::HashMap<String, vapor_core::links::LinkStatus>>(&b).ok())
            {
                vapor_core::links::apply_status(&mut c.links, &statuses);
            }
            if let Err(e) = c.attach_covers(&root.join("covers")) {
                eprintln!("error: {e}");
                return ExitCode::FAILURE;
            }
            let before = c.links.len();
            c.links.retain(|l| l.visible());
            if c.links.len() != before {
                println!("hid {} link(s) whose source is unreachable", before - c.links.len());
            }
            let out = root.join("catalog.json");
            std::fs::write(&out, serde_json::to_vec_pretty(&c).unwrap()).expect("write catalog.json");
            println!("generated {} ({} games)", out.display(), c.games.len());
            ExitCode::SUCCESS
        }
        ("validate" | "index", Err(e)) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
        _ => {
            eprintln!("usage: vapor <validate|index> [repo-root] | vapor audit <zip> --slug <slug> ...");
            ExitCode::from(2)
        }
    }
}
