// Automatic asset-license audit of a checked-out repository.
//
// For every asset file (images, audio, fonts, models, data packs...) it looks for the license
// that actually covers that file:
//   strong  a license/credits file inside the asset's own directory tree, a REUSE annotation
//           (.reuse/dep5, REUSE.toml), a `<file>.license` sidecar or an SPDX header
//   weak    only the repository root's license/README says something (usually the CODE license)
//   none    nothing found
// and flags license text that is incompatible with redistribution (non-commercial, no
// derivatives, freeware, "with permission", ...).
//
// Verdicts: `auto-open` (>= 98 % of asset bytes strongly covered by open licenses, nothing
// bad), `blocked` (bad terms found), `needs-human` (anything else), `no-assets` (no asset
// files; check what the build downloads). It is a heuristic filter that removes the obvious
// work; a person still approves what gets listed.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";

export const ASSET_EXT = new Set((
  "png jpg jpeg gif webp bmp tga dds ico svg ogg oga wav mp3 flac opus mid midi xm it s3m mod " +
  "ttf otf woff woff2 obj mtl glb gltf fbx blend dae tmx tsx webm mp4 ogv pak pk3 wad"
).split(" "));

const SKIP_DIR = /^(\.git|\.github|node_modules|build|dist|out|target|third[_-]?party|thirdparty|vendor|external|extern|deps|docs?|tests?|\.reuse|licenses)$/i;
const LICENSE_FILE = /^(licen[sc]e|copying|unlicense|copyright|notice|credits|authors|attribution|licen[sc]es?-assets?|assets?-licen[sc]e|data-licen[sc]e)(\.[a-z]+)?$/i;
const README_FILE = /^readme(\.[a-z]+)?$/i;
const MAX_TEXT = 512 * 1024;

// Signatures of licenses that allow redistribution.
const OK_SIGNS = [
  [/creativecommons\.org\/publicdomain\/zero|\bCC0\b|Creative Commons Zero|public domain dedication|\bUnlicense\b/i, "CC0/Unlicense"],
  [/creativecommons\.org\/licenses\/by-sa|\bCC[- ]BY[- ]SA\b/i, "CC-BY-SA"],
  [/creativecommons\.org\/licenses\/by\/|\bCC[- ]BY[- ]?\d|\bCC BY\b(?![- ]?(NC|ND|SA))/i, "CC-BY"],
  [/GNU (LESSER |AFFERO )?GENERAL PUBLIC LICENSE|\bA?L?GPL-?\d/i, "GPL-family"],
  [/Permission is hereby granted, free of charge/i, "MIT"],
  [/Redistribution and use in source and binary forms/i, "BSD"],
  [/Apache License,? Version 2\.0/i, "Apache-2.0"],
  [/zlib License|This software is provided 'as-is'/i, "Zlib"],
  [/SIL OPEN FONT LICENSE|\bOFL-?1/i, "OFL"],
  [/\bpublic domain\b/i, "public-domain"],
];
// Terms that make redistribution doubtful.
const BAD_SIGNS = [
  [/non-?commercial|\bCC[- ]BY[- ]NC|\bBY-NC\b/i, "non-commercial"],
  [/no[- ]?derivatives?|\bCC[- ]BY[- ]ND|\bBY-ND\b/i, "no-derivatives"],
  [/\bfreeware\b|\bshareware\b/i, "freeware/shareware"],
  [/personal use only|for personal use|not for redistribution|may not be redistributed/i, "restricted-redistribution"],
  [/(used|included) with (the )?(kind )?permission|by permission of/i, "used-with-permission"],
];
const ALL_RIGHTS = /all rights reserved/i;

/** Classifies license text: which open licenses it mentions and which bad terms it has. */
export function classify(text) {
  const ok = OK_SIGNS.filter(([re]) => re.test(text)).map(([, id]) => id);
  // GPL-2 3c / GPL-3 6c ("allowed only [occasionally and] noncommercially") is license boilerplate,
  // not a restriction on the licensed work.
  const scan = text
    .replace(/occasionally\s+and\s+noncommercially/gi, "") // GPL-3 6c
    .replace(/allowed\s+only\s+for\s+noncommercial\s+distribution\s+and\s+only\s+if\s+you/gi, ""); // GPL-2 3c
  const bad = BAD_SIGNS.filter(([re]) => re.test(scan)).map(([, id]) => id);
  // "Copyright (c) X. All rights reserved." is part of BSD/MIT boilerplate: only bad on its own.
  if (ALL_RIGHTS.test(text) && ok.length === 0) bad.push("all-rights-reserved");
  return { ok, bad };
}

const OK_SPDX = /^(CC0|CC-BY(-SA)?-\d|CC-PDDC|GPL|LGPL|AGPL|MIT|BSD|Apache|Zlib|ISC|OFL|MPL|Unlicense|Artistic|BSL|0BSD|WTFPL)/i;
const BAD_SPDX = /-NC|-ND|proprietary|LicenseRef/i;
export function classifySpdx(id) {
  if (BAD_SPDX.test(id)) return { ok: [], bad: [id] };
  return OK_SPDX.test(id) ? { ok: [id], bad: [] } : { ok: [], bad: [] };
}

function readText(file) {
  try {
    if (statSync(file).size > MAX_TEXT) return "";
    return readFileSync(file, "utf8");
  } catch { return ""; }
}

function* walk(root, rel = "") {
  let entries;
  try { entries = readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIR.test(e.name)) continue;
      yield* walk(root, r);
    } else if (e.isFile()) yield r;
  }
}

// glob -> RegExp. dep5: `*` and `?` match across `/`. REUSE.toml: `**` crosses `/`, `*` does not.
function globToRegex(glob, { dep5 }) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
    else if (c === "*") re += dep5 ? ".*" : "[^/]*";
    else if (c === "?") re += dep5 ? "." : "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function parseDep5(text) {
  const out = [];
  for (const stanza of text.split(/\n\s*\n/)) {
    const files = /^Files:\s*([\s\S]*?)(?=\n[A-Za-z-]+:|$)/m.exec(stanza)?.[1];
    const license = /^License:\s*(\S+)/m.exec(stanza)?.[1];
    if (files && license) out.push({ globs: files.split(/\s+/).filter(Boolean), license });
  }
  return out;
}

function parseReuseToml(text) {
  const out = [];
  for (const block of text.split(/\[\[annotations\]\]/).slice(1)) {
    const p = /path\s*=\s*(\[[^\]]*\]|"[^"]*")/.exec(block)?.[1];
    const l = /SPDX-License-Identifier\s*=\s*"([^"]+)"/.exec(block)?.[1];
    if (p && l) out.push({ globs: [...p.matchAll(/"([^"]+)"/g)].map((m) => m[1]), license: l });
  }
  return out;
}

/** Audits a checked-out repository directory. */
export function auditTree(root) {
  const files = [...walk(root)];
  const dirs = new Map(); // dir -> {ok:Set, bad:Set, strong:boolean}
  const badHits = [];
  const seen = new Set();

  const note = (dir, file, c, strong) => {
    const d = dirs.get(dir) ?? { ok: new Set(), bad: new Set(), strong: false };
    c.ok.forEach((x) => { d.ok.add(x); seen.add(x); });
    c.bad.forEach((x) => d.bad.add(x));
    if (strong && c.ok.length) d.strong = true;
    dirs.set(dir, d);
    for (const b of c.bad) badHits.push({ file, reason: b });
  };

  // 1. License/credit files and READMEs, by directory.
  for (const f of files) {
    const dir = path.posix.dirname(f) === "." ? "" : path.posix.dirname(f);
    const base = path.posix.basename(f);
    if (LICENSE_FILE.test(base)) note(dir, f, classify(readText(path.join(root, f))), dir !== "");
    else if (README_FILE.test(base)) note(dir, f, classify(readText(path.join(root, f))), false);
  }
  // 2. REUSE annotations.
  const reuse = [];
  const dep5 = path.join(root, ".reuse/dep5");
  if (existsSync(dep5)) for (const s of parseDep5(readText(dep5))) reuse.push({ ...s, dep5: true });
  const toml = path.join(root, "REUSE.toml");
  if (existsSync(toml)) for (const s of parseReuseToml(readText(toml))) reuse.push({ ...s, dep5: false });
  for (const s of reuse) s.res = s.globs.map((g) => globToRegex(g, { dep5: s.dep5 }));

  // 3. Per asset file.
  const assets = files.filter((f) => ASSET_EXT.has(path.posix.extname(f).slice(1).toLowerCase()));
  let bytes = 0, strongB = 0, weakB = 0, noneB = 0, badB = 0;
  const uncovered = new Map();
  for (const f of assets) {
    const size = statSync(path.join(root, f)).size;
    bytes += size;
    let level = "none", isBad = false;

    const sidecar = path.join(root, `${f}.license`);
    if (existsSync(sidecar)) {
      const id = /SPDX-License-Identifier:\s*(\S+)/.exec(readText(sidecar))?.[1];
      const c = id ? classifySpdx(id) : classify(readText(sidecar));
      if (c.bad.length) { isBad = true; badHits.push({ file: `${f}.license`, reason: c.bad.join(",") }); }
      else if (c.ok.length) level = "strong";
    }
    if (level === "none" && !isBad) {
      for (const s of reuse) if (s.res.some((re) => re.test(f))) {
        const c = classifySpdx(s.license);
        if (c.bad.length) { isBad = true; badHits.push({ file: f, reason: s.license }); }
        else if (c.ok.length) level = "strong";
        break;
      }
    }
    if (level === "none" && !isBad && /\.svg$/i.test(f)) {
      const id = /SPDX-License-Identifier:\s*([^\s<*]+)/.exec(readText(path.join(root, f)))?.[1];
      if (id) { const c = classifySpdx(id); if (c.bad.length) isBad = true; else if (c.ok.length) level = "strong"; }
    }
    // Nearest enclosing directory with a license/credits note.
    if (level === "none" && !isBad) {
      let dir = path.posix.dirname(f) === "." ? "" : path.posix.dirname(f);
      for (;;) {
        const d = dirs.get(dir);
        if (d) {
          if (d.bad.size) { isBad = true; break; }
          if (d.ok.size) { level = d.strong && dir !== "" ? "strong" : "weak"; break; }
        }
        if (dir === "") break;
        dir = path.posix.dirname(dir) === "." ? "" : path.posix.dirname(dir);
      }
    }
    if (isBad) badB += size;
    else if (level === "strong") strongB += size;
    else if (level === "weak") weakB += size;
    else noneB += size;
    if (!isBad && level !== "strong") {
      const top = f.split("/").slice(0, 2).join("/");
      const u = uncovered.get(top) ?? { dir: top, bytes: 0, files: 0, level };
      u.bytes += size; u.files += 1;
      uncovered.set(top, u);
    }
  }

  const frac = (n) => (bytes ? Math.round((n / bytes) * 1000) / 1000 : 0);
  const coverage = { strong: frac(strongB), weak: frac(weakB), none: frac(noneB), bad: frac(badB) };
  let verdict;
  if (badHits.length) verdict = "blocked";
  else if (assets.length < 3) verdict = "no-assets";
  else if (coverage.strong >= 0.98) verdict = "auto-open";
  else verdict = "needs-human";

  return {
    verdict,
    assets: { files: assets.length, bytes },
    coverage,
    licenses_seen: [...seen].sort(),
    uncovered: [...uncovered.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 10),
    bad_hits: badHits.slice(0, 20),
  };
}
