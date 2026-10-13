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

function parseArgs(argv) {
  const o = { out: "crawl-output", curated: "candidates", maxNew: 15, minStars: 30, watch: false, interval: 3600, refreshDays: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === "--out") o.out = next();
    else if (a === "--curated") o.curated = next();
    else if (a === "--max-new") o.maxNew = Number(next());
    else if (a === "--min-stars") o.minStars = Number(next());
    else if (a === "--interval") o.interval = Number(next());
    else if (a === "--refresh-days") o.refreshDays = Number(next());
    else if (a === "--watch") o.watch = true;
    else { console.error(`unknown option: ${a}`); process.exit(2); }
  }
  for (const k of ["maxNew", "minStars", "interval", "refreshDays"]) {
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
    return { ...rec, ...classify(rec) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
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
  const queue = repos.filter(stale).sort((a, b) => b.stargazers_count - a.stargazers_count).slice(0, o.maxNew);
  console.log(`inspecting ${queue.length} new or changed (limit ${o.maxNew})`);

  for (const repo of queue) {
    try {
      if (await loadJson(path.join(o.curated, fileKey(repo.full_name)), null)) {
        console.log(`  curated            ${repo.full_name} (skipped: hand-reviewed record exists)`);
        state.seen[repo.full_name] = { pushed_at: repo.pushed_at, crawled_at: new Date().toISOString() };
        continue;
      }
      const rec = await inspect(repo);
      await writeFile(path.join(o.out, fileKey(repo.full_name)), JSON.stringify(rec, null, 2) + "\n");
      state.seen[repo.full_name] = { pushed_at: repo.pushed_at, crawled_at: rec.crawled_at };
      console.log(`  ${rec.status.padEnd(18)} ${repo.full_name} (${rec.license.spdx ?? "no license"})`);
    } catch (e) {
      console.error(`  stopped at ${repo.full_name}: ${e.message}`);
    }
  }
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n");

  const files = (await readdir(o.out)).filter((f) => f.endsWith(".json") && !["state.json", "index.json"].includes(f));
  const all = await Promise.all(files.map((f) => loadJson(path.join(o.out, f), null)));
  const rank = { listed: -1, "ready-to-build": 0, "needs-asset-audit": 1, "byo-only": 2, "needs-port": 3, blocked: 4, rejected: 5 };
  const index = all.filter(Boolean)
    .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.stars - a.stars)
    .map((r) => ({ repo: r.repo, status: r.status, stars: r.stars, license: r.license.spdx, wasm: r.signals.wasm, reasons: r.reasons }));
  await writeFile(path.join(o.out, "index.json"), JSON.stringify(index, null, 2) + "\n");
  console.log(`index: ${index.length} candidate record(s) in ${o.out}/index.json`);
}

const opts = parseArgs(process.argv.slice(2));
do {
  await runOnce(opts);
  if (opts.watch) { console.log(`sleeping ${opts.interval}s`); await sleep(opts.interval * 1000); }
} while (opts.watch);
