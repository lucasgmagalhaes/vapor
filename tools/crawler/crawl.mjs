#!/usr/bin/env node
// Continuous crawler: finds open-source games on GitHub that could be ported/packaged for the
// Vapor catalog, classifies license and wasm signals, and writes automated review records to crawl-output/.
// Hand-reviewed records live in candidates/ (committed); repos that have one there are skipped.
//
// It NEVER writes to games/. A human (or a build workflow in vapor-artifacts) turns an approved
// candidate into a game.json. Records are heuristic: always re-read the license files.
//
// Usage:
//   node tools/crawler/crawl.mjs [--out crawl-output] [--curated candidates] [--max-new 15] [--min-stars 30]
//                                [--watch] [--interval 3600] [--refresh-days 30]
// Set GITHUB_TOKEN for a higher search rate limit (an invalid token falls back to anonymous mode).
// Inspection uses blobless git clones, so it does not consume REST API quota.

import { mkdir, readFile, writeFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditTree } from "./license-audit.mjs";

const run = promisify(execFile);

const API = "https://api.github.com";
const QUERIES = [
  "topic:emscripten topic:game",
  "topic:webassembly topic:game",
  "topic:emscripten-port",
  "topic:decompilation topic:game",
  "topic:game-engine topic:remake",
];
// Drop curated lists and other non-game noise from search results.
const NOISE = /(^|[-_/])awesome([-_]|$)|beginners|tutorial|boilerplate|template|\bcourse\b/i;
const GAMEISH = /game|engine|remake|port|decomp|clone|emulat|doom|quake|tycoon|rogue/i;
const OPEN_CODE = /^(GPL|LGPL|AGPL|MIT|BSD|Zlib|Apache|MPL|CC0|Unlicense|ISC|BSL)/i;
const SIGNALS = {
  wasmPaths: /(^|\/)(emscripten|wasm|web)\/|emscripten|\.wasm$/i,
  wasmText: /emscripten|webassembly|\bwasm\b|\bemcc\b|__EMSCRIPTEN__/i,
  openAssets: /cc[- ]?by(-sa)?|cc0|creative commons|public domain|open ?gfx|freedoom|free (art|assets|graphics|content)/i,
  byo: /bring your own|original (game )?(data|assets|files)|own copy|requires? (the )?(original|retail|commercial)|game data (is )?not included|\.(pak|wad|iso|rom)\b/i,
  freeware: /freeware|shareware/i,
};

// Supply-chain signals: things a malicious or careless repository would ship. They never
// change the license status; they add `security.flags` for the human audit (the audit of the
// built artifact, `vapor audit`, is the real gate).
const BINARY_EXT = /\.(exe|dll|so|dylib|jar|apk|msi|scr|bat|cmd|ps1|vbs|dmg|pkg|deb|rpm)$/i;
const RISKY_SCRIPT = [
  [/(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i, "pipe-to-shell"],
  [/\beval\s*\$\(|\beval\s+"\$\(/i, "eval-of-command-output"],
  [/base64\s+(-d|--decode)[^\n]*\|\s*(ba)?sh/i, "decode-and-run"],
  [/powershell[^\n]*-(enc|encodedcommand)\b/i, "powershell-encoded"],
  [/"(pre|post)install"\s*:/i, "npm-install-hook"],
  [/(coinhive|cryptonight|xmrig|stratum\+tcp)/i, "crypto-miner"],
];
const SCRIPT_FILES = /(^|\/)(package\.json|Dockerfile[^/]*|install[^/]*\.sh|build[^/]*\.sh|setup[^/]*\.sh|Makefile|CMakeLists\.txt)$/i;

async function securitySignals(work, paths) {
  const flags = [];
  const binaries = paths.filter((p) => BINARY_EXT.test(p)).slice(0, 10);
  if (binaries.length) flags.push(`committed-binaries(${binaries.length}+)`);
  let submoduleHosts = [];
  if (paths.includes(".gitmodules")) {
    const gm = await blob(work, ".gitmodules");
    submoduleHosts = [...new Set([...gm.matchAll(/url\s*=\s*(\S+)/g)].map((m) => {
      try { return new URL(m[1].replace(/^git@([^:]+):/, "https://$1/")).host.toLowerCase(); } catch { return m[1]; }
    }))];
    const foreign = submoduleHosts.filter((h) => !/(^|\.)(github\.com|gitlab\.com|codeberg\.org)$/.test(h));
    if (foreign.length) flags.push(`submodule-from-unusual-host(${foreign.join(",")})`);
  }
  const risky = [];
  const scripts = paths.filter((p) => SCRIPT_FILES.test(p) && p.split("/").length <= 3).slice(0, 12);
  for (const f of scripts) {
    const text = await blob(work, f);
    for (const [re, name] of RISKY_SCRIPT) if (re.test(text)) risky.push({ file: f, pattern: name });
  }
  if (risky.length) flags.push(...[...new Set(risky.map((r) => r.pattern))].map((n) => `script:${n}`));
  return { flags, binaries, submodule_hosts: submoduleHosts, risky };
}

// ---- duplicate detection --------------------------------------------------------------
// "Several people release the same game": compare normalized names against what is already
// listed/curated, and against the other crawler records.
const NAME_NOISE = /(webassembly|emscripten|decompilation|html5|ported|remake|decomp|wasm|games|game|port|web)/g;
export const coreName = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "").replace(NAME_NOISE, "");
const tokens = (t) => new Set((t ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

async function knownEntries(o) {
  const out = [];
  for (const dir of ["games", o.curated]) {
    let files = [];
    try { files = await readdir(dir); } catch { continue; }
    for (const f of files) {
      if (dir === "games") {
        const m = await loadJson(path.join(dir, f, "game.json"), null);
        if (m) out.push({ id: `games/${m.slug}`, repo: (m.source?.repo ?? "").replace(/^https?:\/\/github\.com\//, "").toLowerCase(), title: m.title });
      } else if (f.endsWith(".json")) {
        const c = await loadJson(path.join(dir, f), null);
        if (c) out.push({ id: `${o.curated}/${c.repo}`, repo: (c.repo ?? "").toLowerCase(), title: c.repo?.split("/")[1] ?? "" });
      }
    }
  }
  return out;
}

export function duplicatesOf(rec, known) {
  const base = rec.repo.split("/")[1];
  const name = coreName(base);
  const tk = tokens(base);
  const hits = [];
  for (const k of known) {
    if (k.repo === rec.repo.toLowerCase()) continue;
    const kn = coreName(k.repo.split("/")[1] ?? k.title ?? "");
    const kt = tokens(k.title);
    const sameName = name.length >= 4 && kn.length >= 4 && (name === kn || name.includes(kn) || kn.includes(name));
    const common = [...tk].filter((w) => kt.has(w)).length;
    if (sameName || (common > 0 && common * 2 >= Math.max(tk.size, kt.size))) hits.push(k.id);
  }
  return hits;
}

// Run `fn` over `items` with at most `n` in flight. Clones do not use API quota, so this is
// safe; the (rate-limited) search stays serial.
async function pool(items, n, fn) {
  const it = items[Symbol.iterator]();
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => {
    for (let r = it.next(); !r.done; r = it.next()) await fn(r.value);
  }));
}

// Which repositories to inspect first when the queue is longer than --max-new: open code
// license, wasm/emscripten topics, then popularity.
export function priority(repo) {
  const topics = (repo.topics ?? []).join(" ");
  let p = Math.log10((repo.stargazers_count ?? 0) + 1);
  if (repo.license?.spdx_id && OPEN_CODE.test(repo.license.spdx_id)) p += 3;
  if (/emscripten|webassembly|wasm/i.test(topics)) p += 2;
  if (/decomp/i.test(topics)) p -= 1; // bring-your-own: slower to turn into a listing
  return p;
}

function parseArgs(argv) {
  const o = { out: "crawl-output", curated: "candidates", maxNew: 15, minStars: 30, watch: false, interval: 3600, refreshDays: 30, concurrency: 4, assetAudit: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === "--out") o.out = next();
    else if (a === "--curated") o.curated = next();
    else if (a === "--max-new") o.maxNew = Number(next());
    else if (a === "--min-stars") o.minStars = Number(next());
    else if (a === "--interval") o.interval = Number(next());
    else if (a === "--refresh-days") o.refreshDays = Number(next());
    else if (a === "--concurrency") o.concurrency = Number(next());
    else if (a === "--no-asset-audit") o.assetAudit = false;
    else if (a === "--watch") o.watch = true;
    else { console.error(`unknown option: ${a}`); process.exit(2); }
  }
  for (const k of ["maxNew", "minStars", "interval", "refreshDays", "concurrency"]) {
    if (!Number.isFinite(o[k]) || o[k] < 0) { console.error(`invalid value for ${k}`); process.exit(2); }
  }
  return o;
}

let useToken = Boolean(process.env.GITHUB_TOKEN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hdrs = () => ({
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "vapor-crawler",
  ...(useToken ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
});

class RateLimited extends Error {}

async function gh(p, { allow404 = true } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API}${p}`, { headers: hdrs() });
    if (res.ok) return res.json();
    if (res.status === 401 && useToken) {
      console.error("warning: GITHUB_TOKEN rejected (401); continuing anonymously (lower rate limit)");
      useToken = false;
      continue;
    }
    if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      const wait = reset - Date.now() + 1000;
      if (wait > 0 && wait <= 65_000) { await sleep(wait); continue; }
      throw new RateLimited(`rate limit exhausted until ${new Date(reset).toISOString()}`);
    }
    if (allow404 && [404, 409, 451].includes(res.status)) return null;
    throw new Error(`GitHub ${res.status} at ${p}`);
  }
  throw new RateLimited(`failed after retries: ${p}`);
}

const fileKey = (full) => `${full.replace("/", "__")}.json`;

async function loadJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

async function discover(minStars) {
  const found = new Map();
  for (const q of QUERIES) {
    const pushed = new Date(Date.now() - 2 * 365 * 864e5).toISOString().slice(0, 10);
    const full = `${q} stars:>=${minStars} archived:false fork:false pushed:>=${pushed}`;
    const r = await gh(`/search/repositories?q=${encodeURIComponent(full)}&sort=stars&order=desc&per_page=30`);
    for (const it of r?.items ?? []) {
      if (NOISE.test(it.full_name) || !GAMEISH.test(`${it.name} ${it.description ?? ""} ${(it.topics ?? []).join(" ")}`)) continue;
      found.set(it.full_name, it);
    }
    await sleep(6500); // search API: 10 requests/min
  }
  return [...found.values()];
}

function classify(rec) {
  const reasons = [];
  const codeOpen = rec.license.spdx && OPEN_CODE.test(rec.license.spdx);
  if (!rec.license.spdx || rec.license.spdx === "NOASSERTION") reasons.push("code license missing or not recognized");
  else if (!codeOpen) reasons.push(`code license ${rec.license.spdx} is not a known open license`);
  if (!rec.signals.wasm) reasons.push("no wasm/emscripten signal found");
  let status;
  if (!codeOpen) status = "rejected";
  else if (rec.signals.byo || rec.decomp) status = "byo-only"; // conservative: assume proprietary assets
  else if (rec.signals.wasm) status = "needs-asset-audit";
  else status = "needs-port";
  if (rec.decomp) reasons.push("decompilation project: the game's original assets are almost certainly proprietary (bring-your-own)");
  if (status === "byo-only" && rec.signals.openAssets) reasons.push("also mentions open-asset terms: check which assets are actually free");
  if (status === "needs-asset-audit") reasons.push("asset licenses must be verified file by file before assets_policy=open");
  if (rec.signals.freeware) reasons.push("mentions freeware/shareware: not an open license");
  return { status, reasons };
}

async function git(dir, ...args) {
  const { stdout } = await run("git", ["-C", dir, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 240_000 });
  return stdout;
}

async function blob(dir, file) {
  try { return (await git(dir, "show", `HEAD:${file}`)).slice(0, 200_000); } catch { return ""; }
}

// Inspection uses a blobless shallow clone (no REST quota): file tree comes from the clone,
// and only the README/LICENSE blobs are fetched.
async function inspect(repo) {
  const work = await mkdtemp(path.join(tmpdir(), "vapor-crawl-"));
  try {
    await run("git", ["clone", "-q", "--depth", "1", "--filter=blob:none", "--no-checkout", repo.clone_url, work], {
      timeout: 240_000, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    const paths = (await git(work, "ls-tree", "-r", "--name-only", "HEAD")).split("\n").filter(Boolean);
    const top = paths.filter((p) => !p.includes("/"));
    const readmeFile = top.find((p) => /^readme(\.(md|txt|rst))?$/i.test(p));
    const licenseFile = top.find((p) => /^(license|licence|copying)(\.(md|txt))?$/i.test(p)) ?? null;
    const readme = readmeFile ? await blob(work, readmeFile) : "";
    const licenseText = licenseFile ? await blob(work, licenseFile) : "";
    const text = [repo.description ?? "", readme, ...(repo.topics ?? [])].join("\n");
    const wasmPaths = paths.filter((p) => SIGNALS.wasmPaths.test(p)).slice(0, 5);
    const rec = {
      repo: repo.full_name,
      url: repo.html_url,
      description: repo.description,
      stars: repo.stargazers_count,
      pushed_at: repo.pushed_at,
      default_branch: repo.default_branch,
      commit_checked: (await git(work, "rev-parse", "HEAD")).trim(),
      license: { spdx: repo.license?.spdx_id ?? null, file: licenseFile },
      signals: {
        wasm: wasmPaths.length > 0 || SIGNALS.wasmText.test(text),
        wasm_paths: wasmPaths,
        openAssets: SIGNALS.openAssets.test(text) || SIGNALS.openAssets.test(licenseText),
        byo: SIGNALS.byo.test(text),
        freeware: SIGNALS.freeware.test(text),
      },
      crawled_at: new Date().toISOString(),
    };
    rec.decomp = /decomp|reverse[- ]engineer|recompil/i.test(`${repo.description ?? ""} ${(repo.topics ?? []).join(" ")}`);
    rec.security = await securitySignals(work, paths);
    const out = { ...rec, ...classify(rec) };
    if (rec.security.flags.length) out.reasons.push(`supply-chain flags: ${rec.security.flags.join(", ")} (read those files before building)`);
    return out;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const MAX_AUDIT_CLONE_KB = 200 * 1024;

// Second stage for candidates that look worth it: a shallow clone with the real files, scanned
// by license-audit.mjs. Moves the record to `ready-to-build` only when every asset byte is
// covered by an open license; `blocked` when incompatible terms are found.
async function assetAudit(repo, rec) {
  if (rec.status !== "needs-asset-audit") return rec;
  if ((repo.size ?? 0) > MAX_AUDIT_CLONE_KB) {
    rec.reasons.push(`repository is ${Math.round(repo.size / 1024)} MB: too large for the automatic asset audit`);
    return rec;
  }
  const work = await mkdtemp(path.join(tmpdir(), "vapor-assets-"));
  try {
    await run("git", ["clone", "-q", "--depth", "1", repo.clone_url, work], {
      timeout: 300_000, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    const a = auditTree(work);
    rec.asset_audit = { ...a, audited_at: new Date().toISOString(), commit: rec.commit_checked };
    const pct = (x) => `${Math.round(x * 100)}%`;
    if (a.verdict === "blocked") {
      rec.status = "blocked";
      rec.reasons.push(`asset license terms incompatible with redistribution: ${a.bad_hits.map((h) => `${h.reason} in ${h.file}`).join("; ")}`);
    } else if (a.verdict === "auto-open") {
      rec.status = rec.signals.wasm ? "ready-to-build" : "needs-port";
      rec.reasons.push(`automatic asset-license audit passed (${pct(a.coverage.strong)} of ${a.assets.files} asset files covered by ${a.licenses_seen.join(", ")}); a person must still read the license files before listing`);
    } else if (a.verdict === "no-assets") {
      rec.reasons.push("no asset files in the repository: check what the build downloads or generates");
    } else {
      rec.reasons.push(`asset licenses not proven: strong ${pct(a.coverage.strong)}, root-only ${pct(a.coverage.weak)}, none ${pct(a.coverage.none)}; largest uncovered: ${a.uncovered.slice(0, 3).map((u) => u.dir).join(", ")}`);
    }
  } catch (e) {
    rec.reasons.push(`asset audit failed: ${e.message.split("\n")[0]}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return rec;
}

async function runOnce(o) {
  await mkdir(o.out, { recursive: true });
  const statePath = path.join(o.out, "state.json");
  const state = await loadJson(statePath, { seen: {} });
  let repos;
  try { repos = await discover(o.minStars); }
  catch (e) { console.error(`discovery stopped: ${e.message}`); return; }
  console.log(`discovered ${repos.length} repositories`);

  const stale = (r) => {
    const s = state.seen[r.full_name];
    if (!s) return true;
    if (s.pushed_at !== r.pushed_at) return true;
    return Date.now() - Date.parse(s.crawled_at) > o.refreshDays * 864e5;
  };
  const known = await knownEntries(o);
  const queue = repos.filter(stale).sort((a, b) => priority(b) - priority(a)).slice(0, o.maxNew);
  console.log(`inspecting ${queue.length} new or changed (limit ${o.maxNew})`);

  const handle = async (repo) => {
    try {
      if (await loadJson(path.join(o.curated, fileKey(repo.full_name)), null)) {
        console.log(`  curated            ${repo.full_name} (skipped: hand-reviewed record exists)`);
        state.seen[repo.full_name] = { pushed_at: repo.pushed_at, crawled_at: new Date().toISOString() };
        return;
      }
      let rec = await inspect(repo);
      if (o.assetAudit) rec = await assetAudit(repo, rec);
      rec.duplicate_of = duplicatesOf(rec, known);
      if (rec.duplicate_of.length) rec.reasons.push(`possible duplicate of ${rec.duplicate_of.join(", ")}: decide which one to keep before building`);
      await writeFile(path.join(o.out, fileKey(repo.full_name)), JSON.stringify(rec, null, 2) + "\n");
      state.seen[repo.full_name] = { pushed_at: repo.pushed_at, crawled_at: rec.crawled_at };
      console.log(`  ${rec.status.padEnd(18)} ${repo.full_name} (${rec.license.spdx ?? "no license"})`);
    } catch (e) {
      console.error(`  stopped at ${repo.full_name}: ${e.message}`);
    }
  };
  await pool(queue, o.concurrency, handle);
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n");

  const files = (await readdir(o.out)).filter((f) => f.endsWith(".json") && !["state.json", "index.json", "duplicates.json"].includes(f));
  const all = await Promise.all(files.map((f) => loadJson(path.join(o.out, f), null)));
  const rank = { listed: -1, "ready-to-build": 0, "needs-asset-audit": 1, "byo-only": 2, "needs-port": 3, blocked: 4, rejected: 5 };
  const index = all.filter(Boolean)
    .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.stars - a.stars)
    .map((r) => ({ repo: r.repo, status: r.status, stars: r.stars, license: r.license.spdx, wasm: r.signals.wasm, security: r.security?.flags ?? [], duplicate_of: r.duplicate_of ?? [], reasons: r.reasons }));
  await writeFile(path.join(o.out, "index.json"), JSON.stringify(index, null, 2) + "\n");

  // Probable duplicates among the records themselves.
  const groups = new Map();
  for (const r of index) {
    const key = coreName(r.repo.split("/")[1]);
    if (key.length >= 4) groups.set(key, [...(groups.get(key) ?? []), r.repo]);
  }
  const dupGroups = [...groups.entries()].filter(([, v]) => v.length > 1).map(([name, repos]) => ({ name, repos }));
  await writeFile(path.join(o.out, "duplicates.json"), JSON.stringify(dupGroups, null, 2) + "\n");
  if (dupGroups.length) console.log(`possible duplicate groups: ${dupGroups.map((g) => g.repos.join(" ~ ")).join(" | ")}`);
  console.log(`index: ${index.length} candidate record(s) in ${o.out}/index.json`);
}

// Only run when executed directly, so the helpers above can be imported by tests.
if (process.argv[1] && path.basename(process.argv[1]) === "crawl.mjs") {
  const opts = parseArgs(process.argv.slice(2));
  do {
    await runOnce(opts);
    if (opts.watch) { console.log(`sleeping ${opts.interval}s`); await sleep(opts.interval * 1000); }
  } while (opts.watch);
}
