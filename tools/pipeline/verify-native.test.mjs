import test from "node:test";
import assert from "node:assert/strict";
import { pickAsset, pickExe, withNative, parseRepo } from "./verify-native.mjs";

const a = (name, size = 1) => ({ name, size });

test("picks the build asset for the platform and ignores checksums and sources", () => {
  assert.equal(pickAsset([a("game_v1_release.zip"), a("SHA256SUMS"), a("game.zip.sha256")], "windows").name, "game_v1_release.zip");
  assert.equal(pickAsset([a("Game-x86_64.AppImage"), a("SHA256SUMS")], "linux").name, "Game-x86_64.AppImage");
  assert.equal(pickAsset([a("game-win64.zip"), a("game-linux.zip")], "windows").name, "game-win64.zip", "name hint breaks the tie");
  assert.equal(pickAsset([a("one.zip"), a("two.zip")], "windows"), null, "two candidates: do not guess");
  assert.equal(pickAsset([a("notes.txt")], "linux"), null);
});

test("picks the program inside a zip without guessing", () => {
  assert.equal(pickExe(["g/run.exe", "g/data.pak"], "g.zip"), "g/run.exe");
  assert.equal(pickExe(["g/run.exe", "g/unins000.exe", "g/vc_redist.x64.exe"], "g.zip"), "g/run.exe", "installers and redistributables are skipped");
  assert.equal(pickExe(["g/a.exe", "g/sub/b.exe"], "g.zip"), "g/a.exe", "shallowest wins");
  assert.equal(pickExe(["g/a.exe", "g/b.exe"], "g.zip"), null, "two at the same depth: ask");
  assert.equal(pickExe([], "Game.AppImage"), "Game.AppImage", "a plain asset is its own program");
});

test("pinning replaces only the build of that platform", () => {
  const entry = { slug: "x", native: [{ platform: "linux", sha256: "l" }, { platform: "windows", sha256: "old" }] };
  const out = withNative(entry, { platform: "windows", sha256: "new" });
  assert.deepEqual(out.native.map((n) => `${n.platform}:${n.sha256}`).sort(), ["linux:l", "windows:new"]);
  assert.equal(withNative({ slug: "y" }, { platform: "linux" }).native.length, 1);
});

test("only github repository pages are supported", () => {
  assert.equal(parseRepo("https://github.com/o/r"), "o/r");
  assert.equal(parseRepo("https://gitlab.com/o/r"), null);
  assert.equal(parseRepo("https://github.com/o/r/releases"), null);
});
