#!/usr/bin/env node
// Turns a crawler record of status `external-only` into links/<slug>.json (a link-only entry).
//
//   node tools/pipeline/make-link.mjs --candidate crawl-output/Owner__repo.json [--slug my-slug] [--root .]
//
// Only facts the record actually has are used. What it cannot know is filled with an honest
// placeholder that the reviewer is asked to correct in the PR (publisher, platforms, needs).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { matchesTitle } from "../crawler/distribution.mjs";

export const PLACEHOLDER_PUBLISHER = "Unknown (see the project's README)";

/** `Owner/Some_Repo.js` -> `some-repo-js` (valid slug, at most 64 chars). */
export function slugFor(repoFullName) {
  const name = (repoFullName.split("/")[1] ?? repoFullName).toLowerCase();
  const slug = name.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
  return slug || "project";
}

export function titleFor(repoFullName) {
  const name = repoFullName.split("/")[1] ?? repoFullName;
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_.]+/g, " ")
    .trim()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** Platforms mentioned in the description; `other` when the record says nothing. */
export function platformsFor(candidate) {
  const text = `${candidate.description ?? ""} ${(candidate.reasons ?? []).join(" ")}`.toLowerCase();
  const found = [];
  if (/\bwindows\b|\bwin32\b|\bwin64\b|\.exe\b/.test(text)) found.push("windows");
  if (/\blinux\b|\bappimage\b/.test(text)) found.push("linux");
  if (/\bmacos\b|\bosx\b|\bmac os\b/.test(text)) found.push("macos");
  if (/\bandroid\b|\bapk\b/.test(text)) found.push("android");
  return found.length ? found : ["other"];
}

// Store evidence from a README can describe a sample game in a generic toolkit. Require the
// verified game's title in the repository's own name or short description before proposing it.
export function isGameSpecificLinkCandidate(candidate) {
  const title = candidate?.distribution?.title;
  const name = candidate?.repo?.split("/")[1] ?? "";
  return candidate?.status === "external-only"
    && candidate.distribution?.status === "verified"
    && typeof title === "string"
    && matchesTitle(title, `${name} ${candidate.description ?? ""}`);
}

export function buildLink(candidate, slug = slugFor(candidate.repo)) {
  if (candidate.status !== "external-only") throw new Error(`status is "${candidate.status}", not external-only`);
  if (!isGameSpecificLinkCandidate(candidate)) throw new Error("verified release and game title in repository name or description required");
  if (!/^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\/[^/]+\/[^/]+$/.test(candidate.url ?? "")) {
    throw new Error("candidate url is not a repository page on a supported host");
  }
  const desc = (candidate.description ?? "").replace(/\s+/g, " ").trim();
  const summary = (desc || `Native port or recompilation: ${candidate.repo}`).slice(0, 297);
  return {
    schema: 1,
    slug,
    title: candidate.distribution.title,
    publisher: PLACEHOLDER_PUBLISHER,
    url: candidate.url,
    platforms: platformsFor(candidate),
    requires: "A copy of the original game that you own (see the project's README)",
    summary: summary.length === 297 ? `${summary}...` : summary,
    legal_note: "Unofficial, third-party project derived from proprietary game code. Not hosted, tested, verified or endorsed by Vapor, which only links to the original source. It does not run inside Vapor. Use at your own risk and check the rights in your country.",
    tags: ["recompilation"],
  };
}

if (process.argv[1] && path.basename(process.argv[1]) === "make-link.mjs") {
  const args = process.argv.slice(2);
  const get = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const candidate = JSON.parse(readFileSync(get("--candidate") ?? "", "utf8"));
  const root = get("--root") ?? ".";
  try {
    const entry = buildLink(candidate, get("--slug"));
    mkdirSync(path.join(root, "links"), { recursive: true });
    const file = path.join(root, "links", `${entry.slug}.json`);
    writeFileSync(file, JSON.stringify(entry, null, 2) + "\n");
    console.log(`wrote ${file}`);
  } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
}
