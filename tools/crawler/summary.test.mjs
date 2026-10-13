import test from "node:test";
import assert from "node:assert/strict";
import { summarize } from "./summary.mjs";

test("summary exposes native links and distribution reviews", () => {
  const text = summarize(
    [{ repo: "a/native-port", status: "external-only", license: "MIT" }],
    [{ repo: "b/console-port", project_kind: "native-port", distribution: { status: "review", reason: "release confirmation needed" } }],
  );
  assert.match(text, /a\/native-port/);
  assert.match(text, /b\/console-port/);
  assert.match(text, /release confirmation needed/);
});
