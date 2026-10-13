import test from "node:test";
import assert from "node:assert/strict";
import { ACHIEVEMENTS, EMPTY, XP, apply, dayKey, levelOf, streak, xpNeeded } from "../../src/progress.ts";

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12);

test("levels get 250 XP longer and carry the leftover", () => {
  assert.deepEqual(levelOf(0), { level: 1, into: 0, need: 500 });
  assert.deepEqual(levelOf(499), { level: 1, into: 499, need: 500 });
  assert.deepEqual(levelOf(500), { level: 2, into: 0, need: 750 });
  assert.deepEqual(levelOf(500 + 750 + 10), { level: 3, into: 10, need: 1000 });
  assert.equal(xpNeeded(12), 500 + 250 * 11);
  assert.equal(levelOf(-5).level, 1);
});

test("installing and first plays give XP once; later plays give a little", () => {
  const t = day(2026, 10, 13);
  let p = apply(EMPTY, { type: "install", slug: "doom" }, t);
  assert.equal(p.xp, XP.install);
  p = apply(p, { type: "install", slug: "doom" }, t);
  assert.equal(p.xp, XP.install, "same game twice");
  p = apply(p, { type: "play", slug: "doom" }, t);
  assert.equal(p.xp, XP.install + XP.play + XP.firstPlay);
  p = apply(p, { type: "play", slug: "doom" }, t);
  assert.equal(p.xp, XP.install + 2 * XP.play + XP.firstPlay);
  assert.deepEqual(p.days, [dayKey(t)], "one entry per day");
});

test("native runs and one-off milestones", () => {
  const t = day(2026, 10, 13);
  let p = apply(EMPTY, { type: "native", slug: "bb" }, t);
  assert.equal(p.xp, XP.native);
  assert.ok(p.flags.includes("native"));
  p = apply(p, { type: "save" }, t);
  p = apply(p, { type: "save" }, t);
  p = apply(p, { type: "byo" }, t);
  assert.equal(p.xp, XP.native + XP.save + XP.byo);
});

test("the streak counts back from today, or from yesterday while today has no game yet", () => {
  const today = day(2026, 10, 13);
  assert.equal(streak([], today), 0);
  assert.equal(streak(["2026-10-13"], today), 1);
  assert.equal(streak(["2026-10-12", "2026-10-11"], today), 2, "today still open");
  assert.equal(streak(["2026-10-13", "2026-10-12", "2026-10-10"], today), 2, "gap breaks it");
  assert.equal(streak(["2026-10-10"], today), 0, "stale");
  assert.equal(streak(["2026-10-01", "2026-09-30", "2026-09-29"], day(2026, 10, 1)), 3, "across a month");
});

test("achievements are unlocked by real events only", () => {
  const today = day(2026, 10, 13);
  const done = (p: typeof EMPTY) => ACHIEVEMENTS.filter((a) => a.done(p, today)).map((a) => a.id);
  assert.deepEqual(done(EMPTY), []);
  let p = apply(EMPTY, { type: "install", slug: "a" }, today);
  p = apply(p, { type: "play", slug: "a" }, today);
  assert.deepEqual(done(p), ["first-install", "first-play"]);
  const week = { ...p, days: ["07", "08", "09", "10", "11", "12", "13"].map((d) => `2026-10-${d}`) };
  assert.ok(done(week).includes("streak-7") && done(week).includes("streak-3"));
});
