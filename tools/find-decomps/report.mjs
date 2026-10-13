#!/usr/bin/env node
// Runs find-decomps for every query in watchlist.json and prints a Markdown report.
// Repositories listed in `reviewed` (already evaluated, accepted or rejected) are skipped.
// Usage: node tools/find-decomps/report.mjs [--query "extra term"]
// This only DISCOVERS public source repositories. It never searches for ROMs, discs or
// other copyrighted assets, and every candidate needs human legal review.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(dir, "watchlist.json"), "utf8"));
const extra = process.argv[2] === "--query" ? process.argv[3] : null;
const queries = extra ? [extra] : cfg.queries;
const reviewed = new Set(cfg.reviewed ?? []);

function run(query) {
  const args = [join(dir, "find-decomps.mjs"), "--deep", "--json", "--min-stars", String(cfg.minStars), "--limit", String(cfg.limit)];
  if (query) args.push("--query", query);
  try {
    return JSON.parse(execFileSync("node", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
  } catch (e) {
    console.error(`warning: search for "${query}" failed: ${e.message.split("\n")[0]}`);
    return null;
  }
}

const out = [`# Decomp discovery`, "", `Generated ${new Date().toISOString().slice(0, 10)}. Candidates only: review code license, asset rights and takedown risk before creating a \`games/<slug>/game.json\`. Add reviewed repositories to \`tools/find-decomps/watchlist.json\` (\`reviewed\`) so they stop appearing.`, ""];
let total = 0;
for (const q of queries) {
  const results = run(q);
  out.push(`## ${q}`, "");
  if (results === null) { out.push("_search failed (see job log)_", ""); continue; }
  const fresh = results.filter((r) => !reviewed.has(r.repo));
  total += fresh.length;
  if (!fresh.length) { out.push("_nothing new_", ""); continue; }
  out.push("| score | repo | stars | license | signals |", "|---|---|---|---|---|");
  for (const r of fresh) {
    const flags = [r.signals.wasm.length ? "wasm?" : "", r.signals.byo ? "BYO?" : "", r.license ? "" : "NO-LICENSE"].filter(Boolean).join(" ");
    out.push(`| ${r.score} | [${r.repo}](${r.url}) | ${r.stars} | ${r.license ?? "-"} | ${flags} |`);
  }
  out.push("");
}
out.push(`_${total} new candidate(s)._`);
console.log(out.join("\n"));
