#!/usr/bin/env node
// Browser smoke test for an extracted game artifact.
//
//   node tools/pipeline/smoke.mjs <dir> <entry> [--seconds 8] [--channel chrome]
//
// Serves <dir> on a random local port with the SAME Content-Security-Policy the Vapor game
// window uses (read from crates/vapor-core/src/serve.rs), loads <entry> in a real browser,
// presses a key and clicks, and reports:
//   * uncaught errors / wasm traps (`ok: false`)
//   * a blank screen (PNG too small to contain a rendered frame)
//   * requests the CSP blocked (the game tried to reach outside its origin)
//   * files that appeared or changed in the Emscripten virtual FS after input: the directories
//     of those files are the `saves.paths` candidates for game.json
// It needs a browser: Google Chrome is used by default (no download); in CI pass
// `--channel chromium` after `npx playwright install chromium`.

import http from "node:http";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The CSP string from serve.rs, so the smoke test can never drift from the app. */
export function gameCsp() {
  const src = readFileSync(path.join(here, "../../crates/vapor-core/src/serve.rs"), "utf8");
  const lit = /pub const GAME_CSP: &str = "((?:[^"\\]|\\.)*)";/s.exec(src)?.[1];
  if (!lit) throw new Error("GAME_CSP not found in serve.rs");
  return lit.replace(/\\\r?\n\s*/g, "").replace(/\\'/g, "'");
}

const MIME = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  css: "text/css", json: "application/json", wasm: "application/wasm", png: "image/png", jpg: "image/jpeg",
  svg: "image/svg+xml", ogg: "audio/ogg", wav: "audio/wav", mp3: "audio/mpeg", txt: "text/plain",
};

export function serve(dir, csp) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
    requests.push(url);
    const file = path.join(dir, url);
    if (!file.startsWith(path.resolve(dir)) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    const ext = path.extname(file).slice(1).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Security-Policy": csp,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests })));
}

const SNAPSHOT = () => {
  const FS = window.Module && window.Module.FS;
  if (!FS) return null;
  const out = {};
  const skip = new Set(["/dev", "/proc", "/tmp"]);
  const walk = (dir, depth) => {
    if (depth > 6 || skip.has(dir)) return;
    let names;
    try { names = FS.readdir(dir); } catch { return; }
    for (const n of names) {
      if (n === "." || n === "..") continue;
      const p = (dir === "/" ? "" : dir) + "/" + n;
      let st;
      try { st = FS.stat(p); } catch { continue; }
      if (FS.isDir(st.mode)) walk(p, depth + 1);
      else if (FS.isFile(st.mode)) out[p] = `${st.size}:${+st.mtime}`;
    }
  };
  walk("/", 0);
  return out;
};

export function diffSnapshots(a, b) {
  if (!a || !b) return [];
  return Object.keys(b).filter((p) => a[p] !== b[p]).sort();
}

/** Parent directories of changed files, without the system roots: the saves.paths candidates. */
export function saveDirs(changed) {
  const dirs = new Set(changed.map((p) => p.slice(0, p.lastIndexOf("/")) || "/"));
  return [...dirs].filter((d) => d !== "/" && !/^\/(dev|proc|tmp)(\/|$)/.test(d)).sort();
}

/** Basenames of every file shipped in the artifact (to tell preloaded files from runtime ones). */
export function shippedNames(dir) {
  const names = new Set();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else names.add(e.name);
    }
  };
  walk(dir);
  return names;
}

/** Files present in the virtual FS that were not shipped in the artifact: the game wrote them. */
export function runtimeCreated(snapshot, shipped) {
  if (!snapshot) return [];
  return Object.keys(snapshot)
    .filter((p) => !/^\/(dev|proc|tmp)\//.test(p) && !shipped.has(p.slice(p.lastIndexOf("/") + 1)))
    .sort();
}

const BASE_DIRS = ["/home/web_user", "/home"]; // Emscripten's default home: never a save root itself

/** Broad, safe suggestion for saves.paths: the first directory below the base dirs. A person narrows it. */
export function suggestSavePaths(files) {
  const roots = new Set();
  for (const f of files) {
    let rest = f;
    for (const b of BASE_DIRS) if (rest.startsWith(`${b}/`)) { rest = rest.slice(b.length); break; }
    const first = rest.split("/").filter(Boolean)[0];
    if (!first || rest.split("/").filter(Boolean).length < 2) continue; // a file directly in the base dir
    const prefix = f.slice(0, f.length - rest.length) + "/" + first;
    roots.add(prefix.replace(/\/\//g, "/"));
  }
  return [...roots].sort();
}

export async function smoke(dir, entry, { seconds = 8, channel = "chrome" } = {}) {
  const csp = gameCsp();
  const { server, port, requests } = await serve(path.resolve(dir), csp);
  const browser = await chromium.launch({ channel, headless: true });
  const reasons = [];
  const consoleErrors = [];
  const cspBlocked = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 1000, height: 720 } })).newPage();
    await page.addInitScript(() => {
      window.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e.message).split("\n")[0]}`));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().split("\n")[0]); });
    await page.goto(`http://127.0.0.1:${port}/${entry}`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForTimeout(Math.min(seconds, 4) * 1000);
    const before = await page.evaluate(SNAPSHOT);
    await page.keyboard.press("Enter");
    await page.mouse.click(500, 360);
    await page.keyboard.press("Space");
    await page.waitForTimeout(Math.max(seconds - 4, 2) * 1000);
    const after = await page.evaluate(SNAPSHOT);
    const png = await page.screenshot();
    cspBlocked.push(...(await page.evaluate(() => window.__csp ?? [])));

    const blank = png.length < 8000;
    const fatal = consoleErrors.filter((e) => /pageerror|RuntimeError|Aborted|abort\(|unreachable|out of bounds|signature mismatch/i.test(e));
    if (fatal.length) reasons.push(`runtime errors: ${[...new Set(fatal)].slice(0, 3).join(" | ")}`);
    if (blank) reasons.push("blank screen after load");
    if (before === null) reasons.push("no Emscripten Module.FS found (cannot infer save paths)");
    const changed = diffSnapshots(before, after);
    const created = runtimeCreated(after, shippedNames(path.resolve(dir)));
    const touched = [...new Set([...changed, ...created])].sort();
    return {
      ok: reasons.length === 0,
      reasons,
      requests: requests.length,
      console_errors: [...new Set(consoleErrors)].slice(0, 10),
      csp_blocked: [...new Set(cspBlocked)].slice(0, 10),
      blank,
      fs_changed: touched.slice(0, 50),
      candidate_save_paths: saveDirs(touched),
      suggested_saves_paths: suggestSavePaths(touched),
    };
  } finally {
    await browser.close();
    server.close();
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === "smoke.mjs") {
  const [dir, entry, ...rest] = process.argv.slice(2);
  if (!dir || !entry) { console.error("usage: smoke.mjs <dir> <entry> [--seconds N] [--channel chrome|chromium]"); process.exit(2); }
  const opt = (name, d) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : d; };
  const report = await smoke(dir, entry, { seconds: Number(opt("--seconds", 8)), channel: opt("--channel", "chrome") });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
