import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { toCover, findReadmeImages, isUsableImageUrl, WIDTH, HEIGHT, MAX_BYTES } from "./make-cover.mjs";

const solid = (w, h, channels = 3) => sharp({ create: { width: w, height: h, channels, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();

test("any image becomes a small WebP of the capsule size", async () => {
  for (const [w, h] of [[1920, 1080], [300, 900], [460, 215], [64, 64]]) {
    const out = await toCover(await solid(w, h));
    const meta = await sharp(out).metadata();
    assert.equal(meta.format, "webp");
    assert.deepEqual([meta.width, meta.height], [WIDTH, HEIGHT], `${w}x${h}`);
    assert.ok(out.length <= MAX_BYTES);
    assert.equal(out.subarray(0, 4).toString(), "RIFF");
    assert.equal(out.subarray(8, 12).toString(), "WEBP");
  }
});

test("a noisy photo still fits the size limit", async () => {
  const noise = Buffer.alloc(1600 * 900 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
  const out = await toCover(await sharp(noise, { raw: { width: 1600, height: 900, channels: 3 } }).png().toBuffer());
  assert.ok(out.length <= MAX_BYTES, `${out.length}`);
});

test("README images: relative paths resolved, badges and non-images skipped, order kept", () => {
  const readme = [
    "[![build](https://img.shields.io/badge/build-passing-green.svg)](https://ci)",
    "![logo](docs/logo.svg)",
    "![shot](docs/screenshots/game.png)",
    '<img src="https://github.com/o/r/blob/main/shots/two.jpg" width=400>',
    "![remote](https://example.com/a/b.webp?raw=1)",
    "![http](http://insecure.example/x.png)",
  ].join("\n");
  assert.deepEqual(findReadmeImages(readme, "o/r", "main"), [
    "https://raw.githubusercontent.com/o/r/main/docs/screenshots/game.png",
    "https://github.com/o/r/raw/main/shots/two.jpg",
    "https://example.com/a/b.webp?raw=1",
  ]);
  assert.equal(isUsableImageUrl("https://img.shields.io/x.png"), false);
  assert.equal(isUsableImageUrl("https://example.com/readme"), false);
});
