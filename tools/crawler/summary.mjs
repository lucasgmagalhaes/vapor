#!/usr/bin/env node
// Prints a Markdown summary of a crawl (used for the workflow's job summary).
//   node tools/crawler/summary.mjs crawl-output >> "$GITHUB_STEP_SUMMARY"
import { readFileSync } from "node:fs";
import path from "node:path";

export function summarize(index) {
  const by = (s) => index.filter((r) => r.status === s);
  const line = (r) =>
    `- ${r.repo} (${r.license ?? "no license"})` +
    (r.security?.length ? ` ⚠ ${r.security.join(", ")}` : "") +
    (r.duplicate_of?.length ? ` ≈ ${r.duplicate_of.join(", ")}` : "");
  const section = (title, rows) => ["", `### ${title}`, ...(rows.length ? rows.map(line) : ["_none_"])];
  return [
    "## Crawl summary",
    "",
    `${index.length} records`,
    ...section("ready-to-build (automatic asset-license audit passed)", by("ready-to-build")),
    ...section("needs-asset-audit (license not proven: a person decides)", by("needs-asset-audit")),
    ...section("blocked (incompatible asset terms)", by("blocked")),
    ...section("byo-only", by("byo-only")),
  ].join("\n");
}

if (process.argv[1] && path.basename(process.argv[1]) === "summary.mjs") {
  const dir = process.argv[2] ?? "crawl-output";
  console.log(summarize(JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8"))));
}
