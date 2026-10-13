#!/usr/bin/env node
// Automatic pull requests: the last step of discovery -> catalog.
//
//   node tools/pipeline/auto-prs.mjs --crawl <crawler-data dir> [--only links|releases]
//        [--links N] [--max-open N] [--min-stars 25] [--dry-run]
//
// links     `external-only` candidates -> a ready-for-review PR adding links/<slug>.json
// releases  new Releases of vapor-artifacts that are not listed yet -> dispatches pipeline.yml,
//           which audits, smoke-tests and opens the PR for the game
//
// Safety rails: no cap by default (--links / --max-open set one),
// never re-proposes something that already has a branch/PR (an old closed PR means "declined"),
// the link's source must be alive right now, and `vapor validate` (duplicates, blocklist, URL
// rules) must pass before anything is pushed. A person always reviews and merges.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyResponse } from "../links/check.mjs";
import { buildLink, slugFor, titleFor } from "./make-link.mjs";

const ARTIFACTS_REPO = "lucasgmagalhaes/vapor-artifacts";

// ---------------------------------------------------------------- pure helpers

/** `https://GitHub.com/Owner/Repo/` -> `github.com/owner/repo` */
export function repoKey(url) {
  return String(url ?? "").replace(/^https?:\/\//i, "").replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
}

export function selectLinkCandidates(records, { existingKeys, existingSlugs, minStars = 25, max = 3 }) {
  return records
    .filter((r) => r.status === "external-only" && (r.stars ?? 0) >= minStars)
    .filter((r) => !existingKeys.has(repoKey(r.url)) && !existingSlugs.has(slugFor(r.repo)))
    .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0))
    .slice(0, max);
}

/** Newest Release per slug whose tag is `<slug>-<run>` and that carries `<slug>.zip`. */
export function selectReleases(releases, { listedSlugs, handledSlugs }) {
  const best = new Map();
  for (const r of releases) {
    const m = /^(.+)-(\d+)$/.exec(r.tag ?? "");
    if (!m) continue;
    const [, slug, run] = m;
    if (!(r.assets ?? []).includes(`${slug}.zip`)) continue;
    if (listedSlugs.has(slug) || handledSlugs.has(slug)) continue;
    if (!best.has(slug) || Number(run) > best.get(slug).run) best.set(slug, { slug, tag: r.tag, run: Number(run) });
  }
  return [...best.values()];
}

/** `# GENERATED ... from the crawler record of Owner/repo.` -> `Owner/repo` */
export function parseGeneratedFrom(yml) {
  return /crawler record of ([\w.-]+\/[\w.-]+?)\.?(?:\s|$)/.exec(yml)?.[1] ?? null;
}

/** The page to open inside a game zip: `<slug>/index.html`, else the only html file near the root. */
export function pickEntry(names, slug) {
  if (names.includes(`${slug}/index.html`)) return `${slug}/index.html`;
  const html = names.filter((n) => /\.html?$/i.test(n) && n.split("/").length <= 2);
  return html.length === 1 ? html[0] : null;
}

// ------------------------------------------------------------------------- I/O

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
const tryJson = (cmd, args) => { try { return JSON.parse(sh(cmd, args)); } catch { return null; } };

function readJsonDir(dir, filter = (f) => f.endsWith(".json")) {
  return existsSync(dir) ? readdirSync(dir).filter(filter).map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"))) : [];
}

function listedState() {
  const keys = new Set(), slugs = new Set();
  for (const l of readJsonDir("links")) { keys.add(repoKey(l.url)); slugs.add(l.slug); }
  if (existsSync("games")) {
    for (const g of readdirSync("games")) {
      const f = path.join("games", g, "game.json");
      if (!existsSync(f)) continue;
      const m = JSON.parse(readFileSync(f, "utf8"));
      keys.add(repoKey(m.source?.repo)); slugs.add(m.slug);
    }
  }
  return { keys, slugs };
}

const hasPr = (head) => (tryJson("gh", ["pr", "list", "--state", "all", "--head", head, "--json", "number"]) ?? []).length > 0;

async function alive(url) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(url);
  if (!m) return false; // only GitHub is liveness-checked automatically
  const headers = { "User-Agent": "vapor-auto-prs", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}`, { headers, signal: AbortSignal.timeout(20_000) });
    return classifyResponse(res.status, await res.json().catch(() => null)).state === "alive";
  } catch { return false; }
}

function linkPrBody(entry, candidate) {
  return [
    `## ${entry.title} (link only)`,
    "",
    "Opened automatically by `tools/pipeline/auto-prs.mjs` from a crawler record. **Nothing here is hosted, run or verified by Vapor**: the entry only lists the project and links its original source.",
    "",
    `- Original source: ${entry.url}`,
    `- Stars: ${candidate.stars}, code license (authors' code only): ${candidate.license?.spdx ?? "unknown"}`,
    `- Source checked alive right before opening this PR`,
    `- \`vapor validate\` passed (URL rules, duplicates against games and links, takedown blocklist)`,
    "",
    "## Please fix in this PR before merging",
    `- [ ] \`publisher\` is a placeholder ("${entry.publisher}"): put the publisher of the original game`,
    `- [ ] \`platforms\` (${entry.platforms.join(", ")}) and \`requires\` are guesses from the description: read the README`,
    "- [ ] The summary is the repository description: reword if needed",
    `- [ ] Cover: run \`node tools/pipeline/find-cover.mjs --query "<real game title>" --write links/${entry.slug}.json\` (official art from Steam/IGDB/RAWG/Wikipedia; the repository title may not be the game's name)`,
    "",
    "## Review checklist",
    "- [ ] You are comfortable with the legal exposure of linking to this project (its license covers the authors' code, **not** the game it runs)",
    "- [ ] Takedown policy applies as usual: delete `links/<slug>.json` and add the slug to `takedown/blocklist.json`",
    "- [ ] Declining = close this PR: the pipeline will never propose this project again",
  ].join("\n");
}

async function linksMode(o) {
  const index = readJsonDir(o.crawl, (f) => f.endsWith(".json") && !["state.json", "index.json", "duplicates.json"].includes(f));
  const { keys, slugs } = listedState();
  const open = (tryJson("gh", ["pr", "list", "--label", "auto-pr", "--state", "open", "--json", "number"]) ?? []).length;
  const room = Math.max(0, o.maxOpen - open);
  console.log(`links: ${index.length} records, ${open} auto PRs already open (cap ${o.maxOpen})`);
  const picked = selectLinkCandidates(index, { existingKeys: keys, existingSlugs: slugs, minStars: o.minStars, max: Math.min(o.links, room) });
  let opened = 0;
  for (const c of picked) {
    const slug = slugFor(c.repo);
    if (hasPr(`link/${slug}`)) { console.log(`  skip ${c.repo}: a PR for link/${slug} already exists (maybe declined)`); continue; }
    if (!(await alive(c.url))) { console.log(`  skip ${c.repo}: source not alive`); continue; }
    const entry = buildLink(c, slug);
    if (o.dryRun) { console.log(`  [dry-run] would open a PR for ${c.repo} (${c.stars} stars) as links/${slug}.json`); continue; }
    sh("git", ["switch", "-C", `link/${slug}`, "origin/main"]);
    sh("node", ["tools/pipeline/make-link.mjs", "--candidate", path.join(o.crawl, `${c.repo.replace("/", "__")}.json`), "--slug", slug]);
    try {
      sh("cargo", ["run", "-q", "-p", "vapor-cli", "--", "validate", "."], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      console.log(`  skip ${c.repo}: vapor validate failed: ${String(e.stderr ?? e.message).split("\n")[0]}`);
      sh("git", ["checkout", "-q", "--", "."]); sh("git", ["clean", "-fdq", "links"]);
      continue;
    }
    sh("git", ["add", "links"]);
    sh("git", ["commit", "-q", "-m", `feat(catalog): list ${entry.title} as a link-only entry`]);
    sh("git", ["push", "-q", "-f", "origin", `link/${slug}`]);
    const url = sh("gh", ["pr", "create", "--base", "main", "--head", `link/${slug}`, "--title", `List ${entry.title} (link only)`, "--body", linkPrBody(entry, c), "--label", "auto-pr"]).trim();
    try { sh("gh", ["workflow", "run", "ci.yml", "--ref", `link/${slug}`]); } catch { /* CI can be started by hand */ }
    console.log(`  opened ${url}`);
    opened++;
  }
  console.log(`links: opened ${opened} PR(s)`);
}

async function releasesMode(o) {
  const releases = (tryJson("gh", ["api", `repos/${ARTIFACTS_REPO}/releases?per_page=100`]) ?? []).map((r) => ({ tag: r.tag_name, assets: (r.assets ?? []).map((a) => a.name) }));
  const { slugs } = listedState();
  const handled = new Set();
  for (const r of releases) {
    const slug = /^(.+)-\d+$/.exec(r.tag ?? "")?.[1];
    if (slug && hasPr(`pipeline/${slug}`)) handled.add(slug);
  }
  const picked = selectReleases(releases, { listedSlugs: slugs, handledSlugs: handled });
  console.log(`releases: ${releases.length} found, ${picked.length} not listed yet`);
  for (const r of picked) {
    let recordFile = null;
    try {
      const yml = Buffer.from(sh("gh", ["api", `repos/${ARTIFACTS_REPO}/contents/.github/workflows/build-${r.slug}.yml`, "--jq", ".content"]).trim(), "base64").toString("utf8");
      const repo = parseGeneratedFrom(yml);
      if (repo) recordFile = `${repo.replace("/", "__")}.json`;
    } catch { /* workflow file missing */ }
    if (!recordFile || !existsSync(path.join(o.crawl, recordFile))) { console.log(`  skip ${r.slug}: no generated build workflow / crawler record (hand-made game: list it by hand)`); continue; }
    const work = mkdtempSync(path.join(tmpdir(), "vapor-auto-"));
    sh("gh", ["release", "download", r.tag, "-R", ARTIFACTS_REPO, "-p", `${r.slug}.zip`, "-D", work]);
    const entry = pickEntry(sh("unzip", ["-Z1", path.join(work, `${r.slug}.zip`)]).split("\n").filter(Boolean), r.slug);
    if (!entry) { console.log(`  skip ${r.slug}: cannot tell which html file is the entry`); continue; }
    const cand = JSON.parse(readFileSync(path.join(o.crawl, recordFile), "utf8"));
    if (o.dryRun) { console.log(`  [dry-run] would dispatch pipeline.yml for ${r.slug} (${r.tag}, entry ${entry})`); continue; }
    sh("gh", ["workflow", "run", "pipeline.yml", "-f", `candidate=${recordFile}`, "-f", `slug=${r.slug}`, "-f", `title=${titleFor(cand.repo)}`, "-f", `entry=${entry}`, "-f", `tag=${r.tag}`]);
    console.log(`  dispatched pipeline.yml for ${r.slug} (${r.tag})`);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === "auto-prs.mjs") {
  const a = process.argv.slice(2);
  const get = (n, d) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
  const o = { crawl: get("--crawl", "crawl-data"), only: get("--only", "all"), links: Number(get("--links", Infinity)), maxOpen: Number(get("--max-open", Infinity)), minStars: Number(get("--min-stars", 25)), dryRun: a.includes("--dry-run") };
  if (!existsSync(o.crawl)) { console.error(`no crawler data at ${o.crawl}`); process.exit(2); }
  if (o.only !== "releases") await linksMode(o);
  if (o.only !== "links") await releasesMode(o);
}
