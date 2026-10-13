#!/usr/bin/env node
// Verifies a native build of a link entry IN A THROWAWAY CI RUNNER (never on a player's machine)
// and pins it in links/<slug>.json so the app may download and run it.
//
//   node tools/pipeline/verify-native.mjs --slug my-game --platform windows|linux
//        [--tag v1.2] [--asset name.zip] [--exe path/inside/zip.exe]
//
// What it does, in order; any failure stops it without touching links/<slug>.json:
//   1. picks the release asset (latest release unless --tag) of the linked GitHub repository
//   2. downloads it, checks size, and compares its SHA-256 with the digest GitHub publishes
//   3. unpacks a zip (never executing anything) and scans the files with ClamAV
//   4. writes the `native` build with trust "scanned"
//
// "scanned" is exactly that: hash pinned + antivirus scan with the signature database of that day.
// It is NOT a review and does not prove the program is safe. The app says so before it runs it.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- pure helpers

const SKIP_ASSET = /(sha256|sha512|checksums?|\.sig$|\.asc$|\.txt$|\.md$|\.json$|source|\.sbom|\.pdb$)/i;

/** The one asset that is the build for `platform`, or null when it is not clear-cut. */
export function pickAsset(assets, platform) {
  const usable = assets.filter((a) => !SKIP_ASSET.test(a.name));
  const match = platform === "linux"
    ? usable.filter((a) => /\.appimage$/i.test(a.name))
    : usable.filter((a) => /\.zip$/i.test(a.name));
  if (match.length === 1) return match[0];
  const hinted = match.filter((a) => (platform === "linux" ? /linux/i : /win/i).test(a.name));
  return hinted.length === 1 ? hinted[0] : null;
}

/** Program to start inside a zip: the only .exe, or the only one at the shallowest depth. */
export function pickExe(zipNames, assetName) {
  if (!/\.zip$/i.test(assetName)) return assetName;
  const exes = zipNames.filter((n) => /\.exe$/i.test(n) && !/(unins|uninstall|setup|redist|crash|updater)/i.test(path.posix.basename(n)));
  if (exes.length === 1) return exes[0];
  const min = Math.min(...exes.map((n) => n.split("/").length));
  const top = exes.filter((n) => n.split("/").length === min);
  return top.length === 1 ? top[0] : null;
}

/** The entry with the native build for `build.platform` replaced (other platforms untouched). */
export function withNative(entry, build) {
  const native = (entry.native ?? []).filter((n) => n.platform !== build.platform);
  native.push(build);
  return { ...entry, native };
}

export function parseRepo(url) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(url ?? "");
  return m ? `${m[1]}/${m[2]}` : null;
}

// ------------------------------------------------------------------------- I/O

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

async function main() {
  const a = process.argv.slice(2);
  const get = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const slug = get("--slug"), platform = get("--platform");
  if (!slug || !["windows", "linux"].includes(platform ?? "")) throw new Error("usage: --slug <slug> --platform windows|linux");
  const file = path.join("links", `${slug}.json`);
  const entry = JSON.parse(readFileSync(file, "utf8"));
  const repo = parseRepo(entry.url);
  if (!repo) throw new Error("only github.com repositories are supported");

  const rel = JSON.parse(sh("gh", ["api", get("--tag") ? `repos/${repo}/releases/tags/${get("--tag")}` : `repos/${repo}/releases/latest`]));
  const assets = (rel.assets ?? []).map((x) => ({ name: x.name, size: x.size, digest: x.digest, url: x.browser_download_url }));
  const asset = get("--asset") ? assets.find((x) => x.name === get("--asset")) : pickAsset(assets, platform);
  if (!asset) throw new Error(`could not pick one ${platform} asset from: ${assets.map((x) => x.name).join(", ")}; pass --asset`);
  if (!asset.url.startsWith(`https://github.com/${repo}/releases/download/`)) throw new Error("unexpected asset URL");
  console.log(`release ${rel.tag_name}: ${asset.name} (${asset.size} bytes)`);

  const work = mkdtempSync(path.join(tmpdir(), "vapor-native-"));
  sh("gh", ["release", "download", rel.tag_name, "-R", repo, "-p", asset.name, "-D", work]);
  const downloaded = path.join(work, asset.name);
  if (statSync(downloaded).size !== asset.size) throw new Error("downloaded size differs from the release metadata");
  const sha = await sha256File(downloaded);
  if (asset.digest && asset.digest !== `sha256:${sha}`) throw new Error(`sha256 differs from the digest GitHub publishes (${asset.digest} vs sha256:${sha})`);
  console.log(`sha256 ${sha}${asset.digest ? " (matches the GitHub digest)" : " (GitHub published no digest)"}`);

  let scanTarget = downloaded, names = [];
  if (/\.zip$/i.test(asset.name)) {
    names = sh("unzip", ["-Z1", downloaded]).split("\n").filter(Boolean);
    if (names.some((n) => n.startsWith("/") || n.includes("..") || n.includes("\\"))) throw new Error("the zip has unsafe paths");
    scanTarget = path.join(work, "x");
    sh("unzip", ["-q", downloaded, "-d", scanTarget]);
  }
  const exe = get("--exe") ?? pickExe(names, asset.name);
  if (!exe) throw new Error("could not tell which program to start; pass --exe");
  if (names.length && !names.includes(exe)) throw new Error(`${exe} is not inside the zip`);

  const clamVersion = sh("clamscan", ["--version"]).trim();
  try {
    sh("clamscan", ["-r", "--infected", "--no-summary", scanTarget]);
  } catch (e) {
    throw new Error(`ClamAV flagged the build, NOT pinning it:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
  }
  console.log(`clean: ${clamVersion}`);

  const build = {
    platform, url: asset.url, sha256: sha, size: asset.size, exe,
    reviewed_by: `automatic scan (${clamVersion.split("/")[0]}) in GitHub Actions run ${process.env.GITHUB_RUN_ID ?? "local"}`,
    reviewed_on: new Date().toISOString().slice(0, 10),
    trust: "scanned",
    notes: `Release ${rel.tag_name}. Hash pinned and scanned with ${clamVersion} in a throwaway CI runner; nobody reviewed the program itself.${asset.digest ? " SHA-256 matches the digest published by GitHub." : ""}`,
  };
  writeFileSync(file, JSON.stringify(withNative(entry, build), null, 2) + "\n");
  console.log(`pinned ${platform} build in ${file}`);
}

if (process.argv[1] && path.basename(process.argv[1]) === "verify-native.mjs") {
  main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
}
