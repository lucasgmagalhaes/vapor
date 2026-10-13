#!/usr/bin/env node
// Liveness check for the link-only entries in links/*.json.
//
//   node tools/links/check.mjs [--links links] [--previous links-status.json] [--out links-status.json]
//
// For every entry it asks the host's API about the linked repository and writes
// `links-status.json` (slug -> { state, checked_at, pushed_at, latest_release, failures }):
//   alive     reachable and recently pushed
//   stale     reachable, no push for a year
//   archived  read-only by the owner
//   gone      404 or disabled (hidden by `vapor index`)
//   blocked   451: removed for legal reasons (hidden)
//   unknown   the check itself failed (network, rate limit); retried next time, hidden only
//             after 3 consecutive failures
// Set GITHUB_TOKEN to avoid the low anonymous rate limit.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const STALE_DAYS = 365;

/** Pure: maps an HTTP status + repository JSON to a state. */
export function classifyResponse(status, body, now = Date.now()) {
  if (status === 451) return { state: "blocked" };
  if (status === 404 || status === 410) return { state: "gone" };
  if (status === 403 || status === 429 || status >= 500 || status === 0) return { state: "unknown" };
  if (status !== 200) return { state: "unknown" };
  if (body?.disabled) return { state: "gone" };
  if (body?.archived) return { state: "archived", pushed_at: body.pushed_at ?? body.last_activity_at ?? null };
  const pushed = body?.pushed_at ?? body?.last_activity_at ?? body?.updated_at ?? null;
  const stale = pushed && now - Date.parse(pushed) > STALE_DAYS * 864e5;
  return { state: stale ? "stale" : "alive", pushed_at: pushed };
}

/** Pure: consecutive-failure bookkeeping. */
export function nextStatus(prev, result, checkedAt, latestRelease = null) {
  const failed = ["unknown", "gone", "blocked"].includes(result.state);
  return {
    state: result.state,
    checked_at: checkedAt,
    pushed_at: result.pushed_at ?? prev?.pushed_at ?? null,
    latest_release: latestRelease ?? prev?.latest_release ?? null,
    failures: failed ? (prev?.failures ?? 0) + 1 : 0,
  };
}

function apiUrl(url) {
  const m = /^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\/([^/]+)\/([^/]+?)\/?$/.exec(url);
  if (!m) return null;
  const [, host, owner, repo] = m;
  if (host === "github.com") return { repo: `https://api.github.com/repos/${owner}/${repo}`, release: `https://api.github.com/repos/${owner}/${repo}/releases/latest` };
  if (host === "codeberg.org") return { repo: `https://codeberg.org/api/v1/repos/${owner}/${repo}`, release: `https://codeberg.org/api/v1/repos/${owner}/${repo}/releases/latest` };
  return { repo: `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${owner}/${repo}`)}`, release: null };
}

async function get(url) {
  const headers = { Accept: "application/json", "User-Agent": "vapor-link-check" };
  if (process.env.GITHUB_TOKEN && url.startsWith("https://api.github.com")) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const dir = opt("--links", "links");
  const out = opt("--out", "links-status.json");
  const prevPath = opt("--previous", out);
  const previous = existsSync(prevPath) ? JSON.parse(readFileSync(prevPath, "utf8")) : {};
  const now = new Date().toISOString();
  const result = {};
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  for (const f of files) {
    const entry = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    const urls = apiUrl(entry.url);
    if (!urls) { console.error(`skip ${entry.slug}: unsupported url`); continue; }
    const r = await get(urls.repo);
    const cls = classifyResponse(r.status, r.body);
    let release = null;
    if (urls.release && (cls.state === "alive" || cls.state === "stale")) {
      const rel = await get(urls.release);
      if (rel.status === 200) release = rel.body?.tag_name ?? null;
    }
    result[entry.slug] = nextStatus(previous[entry.slug], cls, now, release);
    console.log(`${entry.slug.padEnd(34)} ${result[entry.slug].state.padEnd(9)} http=${r.status} failures=${result[entry.slug].failures}`);
  }
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && path.basename(process.argv[1]) === "check.mjs") await main();
