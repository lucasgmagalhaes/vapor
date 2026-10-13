#!/usr/bin/env node
// Finds the OFFICIAL cover of a game through public APIs and records its URL.
//
//   node tools/pipeline/find-cover.mjs --query "God of War III" [--write links/god-of-war-3-pc.json]
//
// Providers, in order (a provider that needs a key is skipped when the key is not set):
//   1. Steam store search          no key   the exact game by name -> store header image (landscape)
//   2. IGDB (Twitch)               key      IGDB_CLIENT_ID + IGDB_CLIENT_SECRET (free Twitch app) -> box art
//   3. RAWG                        key      RAWG_API_KEY (free) -> the game's main image
//   4. Wikipedia                   no key   the infobox image of the game's article (box art)
// IGDB and RAWG cover console-only games far better than the key-less providers; their terms ask
// for credit, which the app shows ("cover: <source>"). Only the URL is stored in `cover` of
// game.json / links/<slug>.json (no copy of the image); it must be on a host that
// crates/vapor-core/src/covers.rs allows.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const UA = { "User-Agent": "vapor-find-cover (https://github.com/lucasgmagalhaes/vapor)" };

/** The hosts the app accepts, read from the Rust source so the two can never drift. */
export function allowedHosts() {
  const src = readFileSync(path.join(here, "../../crates/vapor-core/src/covers.rs"), "utf8");
  const block = /ALLOWED_COVER_HOSTS: &\[&str\] = &\[([^\]]*)\]/s.exec(src)?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

export function normalizeTitle(s) {
  return String(s).toLowerCase().replace(/[™®©]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** The Steam search item that IS this game (exact normalized name), never a "similar" one. */
export function pickSteamApp(items, query) {
  const q = normalizeTitle(query);
  return (items ?? []).find((i) => (i.type ?? "app") === "app" && normalizeTitle(i.name) === q) ?? null;
}

/** The result whose name is exactly the query (IGDB and RAWG both rank loose matches first). */
export function pickByName(results, query) {
  const q = normalizeTitle(query);
  return (results ?? []).find((r) => normalizeTitle(r.name) === q) ?? null;
}

export const steamHeader = (id) => `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`;
export const igdbCover = (imageId) => `https://images.igdb.com/igdb/image/upload/t_cover_big/${imageId}.jpg`;

/** File name of the infobox image in the wikitext of a video-game article. */
export function infoboxImage(wikitext) {
  const head = String(wikitext).slice(0, 8000);
  const m = /\|\s*(?:image|cover)\s*=\s*(?:\[\[)?(?:File:|Image:)?\s*([^\n|\]]+?\.(?:jpe?g|png|webp))/i.exec(head);
  return m ? m[1].trim() : null;
}

/** Keep the URL only if the app will accept it. */
export function acceptable(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && allowedHosts().includes(u.hostname) && /\.(jpe?g|png|webp)(\?|$)/i.test(u.pathname + u.search);
  } catch { return false; }
}

async function json(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return res.json();
}

async function isImage(url) {
  const res = await fetch(url, { method: "HEAD", headers: UA, redirect: "follow", signal: AbortSignal.timeout(20_000) });
  return res.ok && /^image\//.test(res.headers.get("content-type") ?? "");
}

export async function fromSteam(query) {
  const r = await json(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&cc=us&l=en`);
  const app = pickSteamApp(r.items, query);
  if (!app) return null;
  const url = steamHeader(app.id);
  return (await isImage(url)) ? { url, source: "Steam", page: `https://store.steampowered.com/app/${app.id}` } : null;
}

export async function fromIgdb(query, env = process.env) {
  if (!env.IGDB_CLIENT_ID || !env.IGDB_CLIENT_SECRET) return null;
  const token = await json(`https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(env.IGDB_CLIENT_ID)}&client_secret=${encodeURIComponent(env.IGDB_CLIENT_SECRET)}&grant_type=client_credentials`, { method: "POST" });
  const safe = query.replace(/["\\]/g, "");
  const games = await json("https://api.igdb.com/v4/games", {
    method: "POST",
    headers: { "Client-ID": env.IGDB_CLIENT_ID, Authorization: `Bearer ${token.access_token}`, "Content-Type": "text/plain" },
    body: `search "${safe}"; fields name,url,cover.image_id; limit 10;`,
  });
  const g = pickByName(games.filter((x) => x.cover?.image_id), query);
  return g ? { url: igdbCover(g.cover.image_id), source: "IGDB", page: g.url } : null;
}

export async function fromRawg(query, env = process.env) {
  if (!env.RAWG_API_KEY) return null;
  const r = await json(`https://api.rawg.io/api/games?key=${encodeURIComponent(env.RAWG_API_KEY)}&search=${encodeURIComponent(query)}&page_size=10`);
  const g = pickByName((r.results ?? []).filter((x) => x.background_image), query);
  return g ? { url: g.background_image, source: "RAWG", page: `https://rawg.io/games/${g.slug}` } : null;
}

export async function fromWikipedia(query) {
  const api = "https://en.wikipedia.org/w/api.php?format=json&redirects=1&";
  const found = await json(`${api}action=query&list=search&srlimit=5&srsearch=${encodeURIComponent(`${query} video game`)}`);
  const q = normalizeTitle(query);
  const hit = (found.query?.search ?? []).find((s) => normalizeTitle(s.title).replace(/ video game$/, "") === q);
  if (!hit) return null;
  const parsed = await json(`${api}action=parse&prop=wikitext&section=0&page=${encodeURIComponent(hit.title)}`);
  const file = infoboxImage(parsed.parse?.wikitext?.["*"] ?? "");
  if (!file) return null;
  const info = await json(`${api}action=query&prop=imageinfo&iiprop=url|mime&iiurlwidth=460&titles=${encodeURIComponent(`File:${file}`)}`);
  const ii = Object.values(info.query?.pages ?? {})[0]?.imageinfo?.[0];
  // The utm_* tracking query is not needed to fetch the file.
  const url = (ii?.thumburl ?? ii?.url)?.replace(/\?.*$/, "");
  return url ? { url, source: "Wikipedia", page: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, "_"))}` } : null;
}

export async function findCover(query) {
  for (const finder of [fromSteam, fromIgdb, fromRawg, fromWikipedia]) {
    try {
      const r = await finder(query);
      if (r && acceptable(r.url)) return r;
    } catch (e) { console.error(`${finder.name}: ${e.message}`); }
  }
  return null;
}

if (process.argv[1] && path.basename(process.argv[1]) === "find-cover.mjs") {
  const a = process.argv.slice(2);
  const get = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const query = get("--query");
  if (!query) { console.error('usage: find-cover.mjs --query "Game Title" [--write file.json]'); process.exit(2); }
  const r = await findCover(query);
  if (!r) { console.error(`no official cover found for "${query}"`); process.exitCode = 1; } else {
  console.log(`${r.source}: ${r.url}\n  page: ${r.page}`);
  const file = get("--write");
  if (file) {
    const d = JSON.parse(readFileSync(file, "utf8"));
    d.cover = r.url;
    writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
    console.log(`cover set in ${file}`);
  }
  }
}
