import test from "node:test";
import assert from "node:assert/strict";
import { classifyResponse, nextStatus } from "./check.mjs";

const now = Date.parse("2026-10-13T00:00:00Z");
const day = 864e5;
const iso = (daysAgo) => new Date(now - daysAgo * day).toISOString();

test("HTTP outcomes map to states", () => {
  assert.equal(classifyResponse(200, { pushed_at: iso(3) }, now).state, "alive");
  assert.equal(classifyResponse(200, { pushed_at: iso(400) }, now).state, "stale");
  assert.equal(classifyResponse(200, { archived: true, pushed_at: iso(3) }, now).state, "archived");
  assert.equal(classifyResponse(200, { disabled: true }, now).state, "gone");
  assert.equal(classifyResponse(404, null, now).state, "gone");
  assert.equal(classifyResponse(451, null, now).state, "blocked");
  for (const s of [0, 403, 429, 500, 502, 302]) assert.equal(classifyResponse(s, null, now).state, "unknown", String(s));
});

test("failures count consecutive bad checks and reset on recovery", () => {
  let st = nextStatus(undefined, { state: "unknown" }, "t1");
  assert.equal(st.failures, 1);
  st = nextStatus(st, { state: "unknown" }, "t2");
  assert.equal(st.failures, 2);
  st = nextStatus(st, { state: "alive", pushed_at: "p" }, "t3", "v1.0");
  assert.deepEqual([st.failures, st.state, st.latest_release, st.pushed_at], [0, "alive", "v1.0", "p"]);
  st = nextStatus(st, { state: "unknown" }, "t4");
  assert.equal(st.latest_release, "v1.0", "keeps the last known release through a failed check");
});
