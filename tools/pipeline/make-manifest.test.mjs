import test from "node:test";
import assert from "node:assert/strict";
import { buildManifest, prBody, BASELINE_ACCEPT } from "./make-manifest.mjs";

const candidate = {
  repo: "Owner/cool-game",
  url: "https://github.com/Owner/cool-game",
  commit_checked: "a".repeat(40),
  license: { spdx: "GPL-3.0" },
  topics: ["game", "emscripten"],
  asset_audit: { verdict: "auto-open", assets: { files: 10, bytes: 1000 }, coverage: { strong: 1, weak: 0, none: 0, bad: 0 }, licenses_seen: ["CC-BY-SA", "GPL-family"] },
};
const inputs = { slug: "cool-game", title: "Cool Game", entry: "cool-game/index.html", tag: "cool-game-1", sha256: "B".repeat(64), size: 123, savesPaths: ["/home/web_user/.cool"] };

test("builds a manifest only from verified inputs", () => {
  const m = buildManifest(candidate, inputs);
  assert.equal(m.assets_policy, "open");
  assert.equal(m.artifact.url, "https://github.com/lucasgmagalhaes/vapor-artifacts/releases/download/cool-game-1/cool-game.zip");
  assert.equal(m.artifact.sha256, "b".repeat(64));
  assert.deepEqual(m.source, { repo: candidate.url, commit: candidate.commit_checked });
  assert.equal(m.license.assets, "CC-BY-SA, GPL-family");
  assert.deepEqual(m.saves.paths, ["/home/web_user/.cool"]);
});

test("refuses to list anything the audit did not clear", () => {
  for (const verdict of ["needs-human", "blocked", "no-assets"]) {
    const c = { ...candidate, asset_audit: { ...candidate.asset_audit, verdict } };
    assert.throws(() => buildManifest(c, inputs), /only auto-open/);
  }
  assert.throws(() => buildManifest({ ...candidate, asset_audit: undefined }, inputs), /missing/);
});

test("refuses unknown license, bad hash, bad slug and missing save paths", () => {
  assert.throws(() => buildManifest({ ...candidate, license: { spdx: "NOASSERTION" } }, inputs), /license/);
  assert.throws(() => buildManifest(candidate, { ...inputs, sha256: "zz" }), /hash/);
  assert.throws(() => buildManifest(candidate, { ...inputs, slug: "Bad Slug" }), /slug/);
  assert.throws(() => buildManifest(candidate, { ...inputs, savesPaths: [] }), /saves/);
});

test("the baseline accepts only runtime-glue rules, never real findings", () => {
  for (const risky of ["executable-content", "executable-extension", "wasm-malformed", "crypto-miner", "external-host", "capability-websocket", "wasm-unexpected-import-module"]) {
    assert.ok(!BASELINE_ACCEPT.includes(risky), risky);
  }
});

test("the PR body flags failures for the reviewer", () => {
  const manifest = buildManifest(candidate, inputs);
  const body = prBody({ manifest, candidate, smokeReport: { ok: false, reasons: ["blank screen after load"] }, auditOk: false, auditLog: "warn external-host:x" });
  assert.match(body, /FAILED/);
  assert.match(body, /needs a reviewer/);
  assert.match(body, /Checklist/);
});
