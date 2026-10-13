#!/usr/bin/env node
// Makes covers/<key>.webp (460x215, the store "capsule" ratio, under 250 KB).
//
//   node tools/pipeline/make-cover.mjs --key doom-freedoom --screenshot <extracted dir> <entry>
//   node tools/pipeline/make-cover.mjs --key bloodborne --readme owner/repo
//   node tools/pipeline/make-cover.mjs --key my-game --url https://.../image.png
//
// --screenshot  the game's own first frame, rendered by our smoke-test browser: best for open games
//               (the art is the game's own, under its own license)
// --readme      the first real image of the project's README (screenshots), for link-only entries
// --url         any https image
//
// Covers of commercial games are thumbnails of the project's screenshots; they are not official art
// and their copyright stays with the rights holders (see docs/CONTRIBUTING.md).

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";

export const WIDTH = 460, HEIGHT = 215, MAX_BYTES = 200 * 1024;

/** Any image buffer -> WebP cover of the capsule size, shrunk in quality until it fits. */
export async function toCover(buffer) {
  const base = sharp(buffer, { limitInputPixels: 80_000_000 }).resize(WIDTH, HEIGHT, { fit: "cover", position: "attention" });
  for (const quality of [82, 72, 62, 50, 40]) {
    const out = await base.clone().webp({ quality }).toBuffer();
    if (out.length <= MAX_BYTES) return out;
  }
  throw new Error("could not fit the cover in the size limit");
}

const BAD_HOST = /(shields\.io|badge|travis-ci|github\.com\/[^/]+\/[^/]+\/(actions|workflows)|img\.shields|codecov|sponsor|buymeacoffee|ko-fi|discord)/i;

export function isUsableImageUrl(url) {
  if (!/^https:\/\//i.test(url) || BAD_HOST.test(url)) return false;
  return /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url);
}

/** Image URLs of a README, in order, resolved against the repository and filtered. */
export function findReadmeImages(readme, repo, branch = "main") {
  const raw = `https://raw.githubusercontent.com/${repo}/${branch}/`;
  // One scan, so the order of the document is kept (Markdown images and <img> tags interleaved).
  const urls = [...readme.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)|<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1] ?? m[2]);
  return urls
    .map((u) => (/^https?:\/\//i.test(u) ? u : raw + u.replace(/^\.?\//, "")))
    .map((u) => u.replace(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/blob\//, "$1/raw/"))
    .filter(isUsableImageUrl);
}

async function download(url) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000), headers: { "User-Agent": "vapor-make-cover" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if (!/^image\//.test(res.headers.get("content-type") ?? "")) throw new Error(`${url}: not an image`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 10 * 1024 * 1024) throw new Error(`${url}: larger than 10 MB`);
  return buf;
}

async function main() {
  const a = process.argv.slice(2);
  const get = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const key = get("--key");
  if (!key || !/^[a-z0-9-]+$/.test(key)) throw new Error("--key <slug> is required");
  let source;
  if (a.includes("--screenshot")) {
    const [dir, entry] = a.slice(a.indexOf("--screenshot") + 1);
    const { serve, gameCsp } = await import("./smoke.mjs");
    const { chromium } = await import("playwright-core");
    const { server, port } = await serve(path.resolve(dir), gameCsp());
    const browser = await chromium.launch({ channel: get("--channel") ?? "chrome", headless: true });
    try {
      const page = await (await browser.newContext({ viewport: { width: 960, height: 450 } })).newPage();
      await page.goto(`http://127.0.0.1:${port}/${entry}`, { waitUntil: "load" });
      await page.waitForTimeout(Number(get("--seconds") ?? 8) * 1000);
      source = await page.screenshot();
    } finally {
      await browser.close();
      server.close();
    }
  } else if (get("--readme")) {
    const repo = get("--readme");
    const meta = JSON.parse(execFileSync("gh", ["api", `repos/${repo}`], { encoding: "utf8" }));
    const readme = execFileSync("gh", ["api", `repos/${repo}/readme`, "--jq", ".content"], { encoding: "utf8" });
    const text = Buffer.from(readme.trim(), "base64").toString("utf8");
    const candidates = findReadmeImages(text, repo, meta.default_branch);
    if (!candidates.length) throw new Error(`no usable image in the README of ${repo}`);
    for (const url of candidates) {
      try { source = await download(url); console.log(`image: ${url}`); break; } catch (e) { console.error(`skip: ${e.message}`); }
    }
    if (!source) throw new Error("none of the README images could be downloaded");
  } else if (get("--url")) {
    source = await download(get("--url"));
  } else {
    throw new Error("pass --screenshot <dir> <entry>, --readme <owner/repo> or --url <https image>");
  }
  const out = await toCover(source);
  const file = path.join("covers", `${key}.webp`);
  mkdirSync("covers", { recursive: true });
  writeFileSync(file, out);
  console.log(`wrote ${file} (${out.length} bytes)`);
}

if (process.argv[1] && path.basename(process.argv[1]) === "make-cover.mjs") {
  main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
}
