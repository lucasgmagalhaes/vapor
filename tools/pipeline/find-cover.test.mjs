import test from "node:test";
import assert from "node:assert/strict";
import { allowedHosts, normalizeTitle, pickSteamApp, pickByName, steamHeader, igdbCover, infoboxImage, acceptable, fromIgdb, fromRawg } from "./find-cover.mjs";

test("the allowed hosts come from the Rust source and cover every provider", () => {
  const hosts = allowedHosts();
  for (const h of ["upload.wikimedia.org", "shared.fastly.steamstatic.com", "images.igdb.com", "media.rawg.io"]) assert.ok(hosts.includes(h), h);
  for (const url of [steamHeader(1536610), igdbCover("co1abc"), "https://upload.wikimedia.org/wikipedia/en/a/ab/Cover.jpg", "https://media.rawg.io/media/games/a/b.jpg"]) {
    assert.ok(acceptable(url), url);
  }
  for (const url of ["https://evil.example/a.jpg", "http://images.igdb.com/a.jpg", "https://images.igdb.com/a.svg", "not a url"]) {
    assert.ok(!acceptable(url), url);
  }
});

test("only the exact game is accepted, never a similar title", () => {
  assert.equal(normalizeTitle("Forza Horizon 5™"), "forza horizon 5");
  const steam = [{ id: 1, name: "Forza Horizon 5", type: "app" }, { id: 2, name: "Forza Horizon", type: "dlc" }, { id: 3, name: "Forza Horizon", type: "app" }];
  assert.equal(pickSteamApp(steam, "Forza Horizon")?.id, 3, "exact name, app type");
  assert.equal(pickSteamApp([{ id: 1, name: "Forza Horizon 6", type: "app" }], "Forza Horizon"), null);
  assert.equal(pickByName([{ name: "Bloodborne: The Old Hunters" }, { name: "Bloodborne" }], "bloodborne").name, "Bloodborne");
  assert.equal(pickByName([{ name: "Bloodborne: The Old Hunters" }], "Bloodborne"), null);
});

test("the infobox image is read from the wikitext", () => {
  assert.equal(infoboxImage("{{Infobox video game\n| title = Bloodborne\n| image = Bloodborne Cover Wallpaper.jpg\n| caption = x\n}}"), "Bloodborne Cover Wallpaper.jpg");
  assert.equal(infoboxImage("{{Infobox video game\n| image = [[File:God of War III cover art.jpg|250px]]\n}}"), "God of War III cover art.jpg");
  assert.equal(infoboxImage("{{Infobox video game\n| title = X\n}}"), null);
  assert.equal(infoboxImage("| image = diagram.svg"), null, "svg is not box art");
});

test("providers that need a key are skipped without one", async () => {
  assert.equal(await fromIgdb("Bloodborne", {}), null);
  assert.equal(await fromRawg("Bloodborne", {}), null);
  assert.equal(igdbCover("co1abc"), "https://images.igdb.com/igdb/image/upload/t_cover_big/co1abc.jpg");
});
