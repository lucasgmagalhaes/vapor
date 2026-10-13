import test from "node:test";
import assert from "node:assert/strict";
import { classify, isSearchCandidate, projectKind } from "./crawl.mjs";

test("search excludes original hobby games and game engines", () => {
  assert.equal(isSearchCandidate({ full_name: "a/my-game", name: "my-game", description: "An original webassembly game", topics: ["game"] }), false);
  assert.equal(isSearchCandidate({ full_name: "a/engine", name: "engine", description: "Game engine decompilation framework", topics: ["game"] }), false);
  assert.equal(isSearchCandidate({ full_name: "a/quest-decomp", name: "quest-decomp", description: "Decompilation of Example Quest", topics: ["game"] }), true);
  assert.equal(projectKind("Bloodborne running natively on Windows"), "native-port");
  assert.equal(projectKind("bbport — a native Linux port of Bloodborne"), "native-port");
  assert.equal(projectKind("A playable preview of Forza Horizon static recompilation"), "decompilation");
  assert.equal(projectKind("God of War III original x86-64 code runs directly on the CPU"), "native-port");
  assert.equal(isSearchCandidate({ full_name: "Supermedo/bloodborne_pc", name: "bloodborne_pc", description: "Bloodborne running natively on Windows 10/11: launcher in 13 languages", topics: [] }), true);
  assert.equal(isSearchCandidate({ full_name: "arcanite24/pinyon-shift", name: "pinyon-shift", description: "A playable preview of Forza Horizon static recompilation", topics: ["static-recompilation"] }), true);
  assert.equal(isSearchCandidate({ full_name: "FelipePrado0/gow3_pc", name: "gow3_pc", description: "Windows port of God of War III Remastered (PS4). Original x86-64 code runs directly on the CPU with a custom runtime; 240 FPS engine frame rate.", topics: ["pc-port"] }), true);
});

test("classification requires both decompilation and confirmed distribution", () => {
  const rec = { decomp: true, project_kind: "decompilation", distribution: { status: "verified" }, license: { spdx: "MIT" }, signals: { wasm: true, byo: true, openAssets: false, freeware: false, consolePort: false } };
  assert.equal(classify(rec).status, "byo-only");
  assert.equal(classify({ ...rec, decomp: false, project_kind: null }).status, "not-target-project");
  assert.equal(classify({ ...rec, distribution: { status: "review", reason: "review required" } }).status, "distribution-unverified");
  assert.equal(classify({ ...rec, decomp: false, project_kind: "native-port" }).status, "external-only");
});
