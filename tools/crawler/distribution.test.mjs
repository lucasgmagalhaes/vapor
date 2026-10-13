import test from "node:test";
import assert from "node:assert/strict";
import { storeLinks, verifyDistribution } from "./distribution.mjs";

test("accepts only product links on official store hosts", () => {
  assert.deepEqual(storeLinks("https://store.steampowered.com.evil.test/app/123/"), []);
  assert.deepEqual(storeLinks("https://store.steampowered.com/app/123/Game"), [
    { platform: "steam", url: "https://store.steampowered.com/app/123/Game", slug: "123" },
  ]);
});

test("requires a released Steam game whose title appears in the project text", async () => {
  const fetcher = async () => ({
    ok: true,
    json: async () => ({ 123: { success: true, data: { name: "Example Quest", type: "game", release_date: { coming_soon: false } } } }),
  });
  const text = "Reverse engineered Example Quest. https://store.steampowered.com/app/123/Example_Quest/";
  assert.equal((await verifyDistribution(text, fetcher)).status, "verified");
  assert.equal((await verifyDistribution("Unrelated project https://store.steampowered.com/app/123/Example_Quest/", fetcher)).status, "unverified");
  assert.equal((await verifyDistribution("Reverse engineered Example Quest", fetcher)).status, "unverified");
});

test("rejects Steam tools and unreleased games", async () => {
  for (const data of [
    { type: "tool", release_date: { coming_soon: false } },
    { type: "game", release_date: { coming_soon: true } },
  ]) {
    const fetcher = async () => ({ ok: true, json: async () => ({ 123: { success: true, data: { name: "Example Quest", ...data } } }) });
    assert.equal((await verifyDistribution("Example Quest https://store.steampowered.com/app/123/", fetcher)).status, "unverified");
  }
});

test("console product pages require release review", async () => {
  const url = "https://www.playstation.com/en-us/games/example-quest/";
  const fetcher = async () => ({ ok: true, url, text: async () => '<meta property="og:title" content="Example Quest | PlayStation">' });
  const evidence = await verifyDistribution(`Example Quest port ${url}`, fetcher);
  assert.equal(evidence.status, "review");
  assert.equal(evidence.platform, "playstation");
});
