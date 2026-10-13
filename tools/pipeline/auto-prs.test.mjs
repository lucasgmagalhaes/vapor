import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLink, isGameSpecificLinkCandidate, slugFor, titleFor, platformsFor, PLACEHOLDER_PUBLISHER } from "./make-link.mjs";
import { indexedLinkRecords, repoKey, selectLinkCandidates, selectReleases, parseGeneratedFrom, pickEntry } from "./auto-prs.mjs";

const rec = (repo, stars, extra = {}) => ({
  repo, url: `https://github.com/${repo}`, stars, status: "external-only", description: "Recompilation of Some Game for Windows and Linux", license: { spdx: "MIT" },
  distribution: { status: "verified", title: "Some Game", platform: "steam", url: "https://store.steampowered.com/app/123/some_game/" },
  ...extra,
});

test("slugs and titles are derived from the repository name", () => {
  assert.equal(slugFor("Owner/Some_Repo.js"), "some-repo-js");
  assert.equal(slugFor("o/--Weird__Name--"), "weird-name");
  assert.equal(slugFor("o/" + "a".repeat(100)).length, 64);
  assert.equal(titleFor("o/LostOdysseyRecomp"), "Lost Odyssey Recomp");
  assert.equal(titleFor("o/god-of-war_recomp"), "God Of War Recomp");
});

test("a link entry only contains facts from the record, with an honest placeholder publisher", () => {
  const e = buildLink(rec("Owner/some-recomp", 100));
  assert.equal(e.publisher, PLACEHOLDER_PUBLISHER);
  assert.equal(e.title, "Some Game");
  assert.equal(e.url, "https://github.com/Owner/some-recomp");
  assert.deepEqual(e.platforms, ["windows", "linux"]);
  assert.match(e.legal_note, /not hosted, tested, verified or endorsed by Vapor/i);
  assert.ok(e.summary.length <= 300);
  assert.deepEqual(platformsFor({ description: "no hints" }), ["other"]);
  assert.throws(() => buildLink({ ...rec("o/r", 1), status: "needs-asset-audit" }), /not external-only/);
  assert.throws(() => buildLink({ ...rec("o/r", 1), url: "https://evil.example/o/r" }), /supported host/);
  const long = buildLink(rec("o/r", 1, { description: `Some Game ${"x".repeat(500)}` }));
  assert.ok(long.summary.length <= 300);
});

test("automatic links require verified evidence for the specific game", () => {
  const generic = rec("snuri00/psp-web-recomp", 282, {
    description: "PSP games in the browser without an emulator: static recompilation to WebAssembly",
    distribution: { status: "verified", title: "God of War: Chains of Olympus", platform: "playstation", url: "https://store.playstation.com/example" },
  });
  assert.equal(isGameSpecificLinkCandidate(generic), false);
  assert.equal(isGameSpecificLinkCandidate({ ...generic, distribution: undefined }), false, "old crawler records must not bypass the gate");
  assert.throws(() => buildLink(generic), /game title in repository name or description/);
  assert.equal(isGameSpecificLinkCandidate(rec("arcanite24/pinyon-shift", 100, {
    description: "A playable preview of Forza Horizon static recompilation",
    distribution: { status: "verified", title: "Forza Horizon", platform: "xbox", url: "https://www.xbox.com/example" },
  })), true);
  assert.deepEqual(selectLinkCandidates([generic, rec("a/real-game", 100)], {
    existingKeys: new Set(), existingSlugs: new Set(), minStars: 25, max: 5,
  }).map((r) => r.repo), ["a/real-game"]);
});

test("old standalone records outside the verified index cannot create PRs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vapor-link-index-"));
  try {
    const legacy = { ...rec("snuri00/psp-web-recomp", 282), distribution: undefined };
    const valid = rec("a/some-game", 100);
    writeFileSync(path.join(dir, "snuri00__psp-web-recomp.json"), JSON.stringify(legacy));
    writeFileSync(path.join(dir, "a__some-game.json"), JSON.stringify(valid));
    writeFileSync(path.join(dir, "index.json"), JSON.stringify([{ repo: valid.repo, status: "external-only", distribution: valid.distribution }]));
    assert.deepEqual(indexedLinkRecords(dir).map((r) => r.repo), [valid.repo]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("link candidates: only external-only, popular enough, not listed, best first, capped", () => {
  const records = [rec("a/big", 900), rec("a/mid", 100), rec("a/small", 3), rec("a/listed", 500), rec("a/slug-clash", 400, {}), { ...rec("a/other", 800), status: "needs-asset-audit" }];
  const picked = selectLinkCandidates(records, {
    existingKeys: new Set([repoKey("https://GitHub.com/a/listed/")]),
    existingSlugs: new Set(["slug-clash"]),
    minStars: 25,
    max: 2,
  });
  assert.deepEqual(picked.map((r) => r.repo), ["a/big", "a/mid"]);
  assert.deepEqual(selectLinkCandidates(records, { existingKeys: new Set(), existingSlugs: new Set(), minStars: 25, max: 0 }), []);
});

test("releases: newest per slug, needs the zip asset, skips listed and already handled", () => {
  const releases = [
    { tag: "cool-1", assets: ["cool.zip"] },
    { tag: "cool-3", assets: ["cool.zip"] },
    { tag: "listed-2", assets: ["listed.zip"] },
    { tag: "handled-1", assets: ["handled.zip"] },
    { tag: "nozip-1", assets: ["notes.txt"] },
    { tag: "v1.0", assets: ["app.msi"] },
    { tag: "multi-word-9", assets: ["multi-word.zip"] },
  ];
  const picked = selectReleases(releases, { listedSlugs: new Set(["listed"]), handledSlugs: new Set(["handled"]) });
  assert.deepEqual(picked.map((r) => `${r.slug}@${r.tag}`).sort(), ["cool@cool-3", "multi-word@multi-word-9"]);
});

test("the generated build workflow names its crawler record", () => {
  assert.equal(parseGeneratedFrom("# GENERATED by vapor tools/pipeline/gen-build.mjs from the crawler record of Owner/cool-game.\n# next"), "Owner/cool-game");
  assert.equal(parseGeneratedFrom("# hand-written"), null);
});

test("the entry page is found without guessing", () => {
  assert.equal(pickEntry(["cool/index.html", "cool/a.wasm", "cool/other.html"], "cool"), "cool/index.html");
  assert.equal(pickEntry(["cool/game.html", "cool/a.wasm"], "cool"), "cool/game.html");
  assert.equal(pickEntry(["cool/a.html", "cool/b.html"], "cool"), null, "two candidates: do not guess");
  assert.equal(pickEntry(["cool/a.wasm"], "cool"), null);
});
