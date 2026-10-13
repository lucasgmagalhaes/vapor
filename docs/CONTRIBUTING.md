# Contributing

## Adding a game
1. Create `games/<slug>/game.json` following `schema/game.schema.json` (see `docs/examples/game.example.json`).
2. `assets_policy` must be `open` or `bring-your-own`. Commercial games with bundled assets are **not** accepted.
3. Host the artifact yourself (HTTPS) and provide the correct `sha256` and `size`.
4. For `bring-your-own` games, list every file the player must supply in `byo_files` (`name`, `description`, `sha256`, `size`, `mount`). Vapor asks the player for each file, verifies size and SHA-256 on their machine, and mounts it at `mount` in the wasm virtual FS. The files are never uploaded and never stored in this repository. Do not include download links to copyrighted assets.
5. Run `cargo run -p vapor-cli -- validate .` and open the PR.

## Covers
Every game and link-only entry can have a store-style cover (460x215 ratio):
- **Official art** (preferred): `node tools/pipeline/find-cover.mjs --query "Game Title" --write games/<slug>/game.json`
  looks the game up in public APIs (Steam, then IGDB and RAWG when `IGDB_CLIENT_ID`/`IGDB_CLIENT_SECRET`
  or `RAWG_API_KEY` are set, then Wikipedia's infobox) and stores only the **URL** in `cover`. No copy of
  commercial art is kept in the repository; the image is loaded from its source. Hosts are allow-listed
  in `crates/vapor-core/src/covers.rs`.
- **Your own art** (open games with no commercial cover): `covers/<slug>.webp` (or `covers/<group>.webp`
  for a group of link entries), at most 250 KB, a real WebP; `vapor validate` checks it and `vapor index`
  attaches its URL. `node tools/pipeline/make-cover.mjs --key <slug> --screenshot <dir> <entry>` makes one
  from the game's own first frame.

## Removing a game
Delete `games/<slug>/` (and, for a takedown, add it to `takedown/blocklist.json`).

## Development
- `make dev` (same as `pnpm install && pnpm tauri dev`; Linux needs libwebkit2gtk-4.1-dev and libgtk-3-dev). `make` lists the other targets, `make check` runs what CI runs.
- `cargo test --workspace` tests the core (`crates/vapor-core`), with no system dependencies.
