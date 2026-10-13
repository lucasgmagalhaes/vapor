import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { detectRecipe, renderWorkflow } from "./gen-build.mjs";

const reader = (files) => (p) => files[p] ?? null;
const candidate = { repo: "Owner/cool", url: "https://github.com/Owner/cool", commit_checked: "c".repeat(40), license: { spdx: "GPL-2.0" } };

test("detects an upstream Emscripten Dockerfile first", () => {
  const r = detectRecipe(["CMakeLists.txt", "emscripten/Dockerfile", "src/a.c"], reader({}));
  assert.equal(r.kind, "emscripten-dockerfile");
  assert.equal(r.context, "emscripten");
});

test("detects CMake + Emscripten from the build files or the README", () => {
  assert.equal(detectRecipe(["CMakeLists.txt"], reader({ "CMakeLists.txt": "if(EMSCRIPTEN)\nendif()" })).kind, "cmake-emscripten");
  assert.equal(detectRecipe(["CMakeLists.txt", "README.md"], reader({ "CMakeLists.txt": "project(x)", "README.md": "build the web version with emcmake cmake" })).kind, "cmake-emscripten");
  assert.equal(detectRecipe(["CMakeLists.txt"], reader({ "CMakeLists.txt": "project(x)" })), null, "plain CMake is not a web recipe");
});

test("detects a Makefile that calls emcc, and gives up otherwise", () => {
  assert.equal(detectRecipe(["Makefile"], reader({ Makefile: "CC=emcc" })).kind, "makefile-emscripten");
  assert.equal(detectRecipe(["main.c"], reader({})), null);
});

test("the workflow pins the commit, audits, publishes and prints the hash", () => {
  const yml = renderWorkflow(candidate, "cool", { kind: "cmake-emscripten", note: "n" });
  assert.match(yml, /SRC_COMMIT: c{40}/);
  assert.match(yml, /name: build-cool/);
  assert.match(yml, /emcmake cmake/);
  assert.match(yml, /audit "\$SLUG\.zip" --slug "\$SLUG" --scan-only/);
  assert.match(yml, /softprops\/action-gh-release@v2/);
  assert.match(yml, /steps\.hash\.outputs\.sha256/);
  assert.match(yml, /\$\{\{ github\.run_number \}\}/);
  assert.doesNotMatch(yml, /secrets\./, "no secrets in a generated build");
});

test("refuses unsafe or incomplete inputs", () => {
  const recipe = { kind: "cmake-emscripten", note: "n" };
  assert.throws(() => renderWorkflow(candidate, "Bad Slug", recipe), /slug/);
  assert.throws(() => renderWorkflow({ ...candidate, commit_checked: "main" }, "cool", recipe), /pinned/);
  assert.throws(() => renderWorkflow({ ...candidate, url: "https://evil.example/x/y" }, "cool", recipe), /GitHub/);
  assert.throws(() => renderWorkflow(candidate, "cool", null), /no build recipe/);
});

test("every recipe renders valid YAML with the expected structure", () => {
  for (const recipe of [
    { kind: "cmake-emscripten", note: "n" },
    { kind: "makefile-emscripten", note: "n" },
    { kind: "emscripten-dockerfile", dockerfile: "emscripten/Dockerfile", context: "emscripten", note: "n" },
  ]) {
    const doc = parse(renderWorkflow(candidate, "cool", recipe));
    assert.equal(doc.name, "build-cool");
    assert.equal(doc.env.SRC_COMMIT, "c".repeat(40));
    const steps = doc.jobs.build.steps;
    assert.ok(steps.some((s) => String(s.name ?? "").startsWith("Security audit")));
    assert.ok(steps.some((s) => s.uses?.startsWith("softprops/action-gh-release")));
    assert.ok(steps.length >= 9, `${recipe.kind}: ${steps.length} steps`);
  }
});
