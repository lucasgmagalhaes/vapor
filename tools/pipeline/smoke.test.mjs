import test from "node:test";
import assert from "node:assert/strict";
import { gameCsp, diffSnapshots, saveDirs, runtimeCreated, suggestSavePaths } from "./smoke.mjs";

test("the CSP is read from serve.rs and blocks network access", () => {
  const csp = gameCsp();
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.doesNotMatch(csp, /https?:/);
  assert.doesNotMatch(csp, /\\/);
});

test("snapshot diff lists new and changed files only", () => {
  const a = { "/a": "1:1", "/b": "2:1" };
  const b = { "/a": "1:1", "/b": "3:2", "/c": "1:1" };
  assert.deepEqual(diffSnapshots(a, b), ["/b", "/c"]);
  assert.deepEqual(diffSnapshots(null, b), []);
});

test("runtime-created files exclude shipped names and system dirs", () => {
  const snap = { "/doom1.wad": "1:1", "/libsdl/x/save.dsg": "1:1", "/tmp/t": "1:1", "/dev/null": "0:0" };
  assert.deepEqual(runtimeCreated(snap, new Set(["doom1.wad"])), ["/libsdl/x/save.dsg"]);
});

test("save path candidates and broad suggestions", () => {
  const files = ["/libsdl/doom-ws-wasm/music-packs/README.txt", "/home/web_user/.openttd/save/a.sav", "/home/web_user/loose.txt"];
  assert.deepEqual(saveDirs(files), ["/home/web_user", "/home/web_user/.openttd/save", "/libsdl/doom-ws-wasm/music-packs"]);
  assert.deepEqual(suggestSavePaths(files), ["/home/web_user/.openttd", "/libsdl"]);
});
