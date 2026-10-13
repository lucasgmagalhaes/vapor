import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditTree, classify, classifySpdx } from "./license-audit.mjs";

function tree(files) {
  const root = mkdtempSync(path.join(tmpdir(), "lic-"));
  for (const [rel, data] of Object.entries(files)) {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, data);
  }
  return root;
}
const png = "x".repeat(100);
const withAssets = (extra) => ({
  "LICENSE": "GNU GENERAL PUBLIC LICENSE Version 2",
  "src/main.c": "int main(){}",
  "data/gfx/a.png": png, "data/gfx/b.png": png, "data/sfx/c.ogg": png,
  ...extra,
});

test("classify: open licenses, bad terms, and the BSD 'all rights reserved' boilerplate", () => {
  assert.deepEqual(classify("Licensed under CC0 1.0").ok, ["CC0/Unlicense"]);
  assert.ok(classify("see https://creativecommons.org/licenses/by-sa/4.0/").ok.includes("CC-BY-SA"));
  assert.ok(classify("CC BY-NC 4.0").bad.includes("non-commercial"));
  assert.ok(classify("Free for personal use only").bad.includes("restricted-redistribution"));
  assert.ok(classify("Copyright (c) 2020 X. All rights reserved. Redistribution and use in source and binary forms").bad.length === 0);
  assert.deepEqual(classify("Copyright X. All rights reserved.").bad, ["all-rights-reserved"]);
  assert.deepEqual(classify("GNU GENERAL PUBLIC LICENSE c) allowed only occasionally and noncommercially, and").bad, []);
  assert.deepEqual(classify("GNU GENERAL PUBLIC LICENSE (This alternative is allowed only for noncommercial distribution and only if you received the program in object code").bad, []);
  assert.ok(classifySpdx("CC-BY-NC-4.0").bad.length === 1);
  assert.ok(classifySpdx("CC-BY-SA-4.0").ok.length === 1);
});

test("assets under their own license file are auto-open", () => {
  const r = auditTree(tree(withAssets({ "data/LICENSE": "Creative Commons Zero\nhttps://creativecommons.org/publicdomain/zero/1.0/" })));
  assert.equal(r.verdict, "auto-open");
  assert.equal(r.coverage.strong, 1);
});

test("only the root (code) license covering assets is not enough", () => {
  const r = auditTree(tree(withAssets({})));
  assert.equal(r.verdict, "needs-human");
  assert.equal(r.coverage.weak, 1);
  assert.ok(r.uncovered.length > 0);
});

test("non-commercial terms block the game", () => {
  const r = auditTree(tree(withAssets({ "data/CREDITS": "Sprites by Bob, CC BY-NC 4.0" })));
  assert.equal(r.verdict, "blocked");
  assert.equal(r.bad_hits[0].reason, "non-commercial");
});

test("REUSE dep5 annotations cover files", () => {
  const dep5 = "Format: x\n\nFiles: data/*\nCopyright: me\nLicense: CC-BY-SA-4.0\n";
  const r = auditTree(tree(withAssets({ ".reuse/dep5": dep5 })));
  assert.equal(r.verdict, "auto-open");
});

test("REUSE.toml and sidecar licenses cover files", () => {
  const toml = '[[annotations]]\npath = ["data/**"]\nSPDX-License-Identifier = "CC0-1.0"\n';
  assert.equal(auditTree(tree(withAssets({ "REUSE.toml": toml }))).verdict, "auto-open");
  const side = withAssets({});
  for (const f of ["data/gfx/a.png", "data/gfx/b.png", "data/sfx/c.ogg"]) side[`${f}.license`] = "SPDX-License-Identifier: CC-BY-4.0";
  assert.equal(auditTree(tree(side)).verdict, "auto-open");
  const nc = withAssets({ "data/gfx/a.png.license": "SPDX-License-Identifier: CC-BY-NC-4.0" });
  assert.equal(auditTree(tree(nc)).verdict, "blocked");
});

test("repositories without assets are not auto-approved", () => {
  const r = auditTree(tree({ "LICENSE": "MIT\nPermission is hereby granted, free of charge", "src/a.c": "x" }));
  assert.equal(r.verdict, "no-assets");
});

test("a mixed tree is not auto-open", () => {
  const r = auditTree(tree(withAssets({ "data/gfx/LICENSE": "CC0", "data/sfx/d.ogg": png.repeat(50) })));
  assert.notEqual(r.verdict, "auto-open");
  assert.ok(r.coverage.strong < 0.98);
});
