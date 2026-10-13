# Vapor

Desktop app (Tauri 2: Rust + React/TypeScript/Vite): a "Steam" for games decompiled/ported to WebAssembly — open catalog + player save management. Public repository; contributing means opening a PR; removing a game must be trivial (copyright risk).

## Commands
- `cargo test --workspace` — core and CLI (no system libs needed)
- `cargo run -p vapor-cli -- validate .` — validates `games/*/game.json` and the blocklist (CI runs this)
- `cargo run -p vapor-cli -- index .` — generates `catalog.json` (git-ignored)
- `pnpm install && pnpm build` — frontend (tsc + vite)
- `pnpm tauri dev` — full app. Linux needs `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`
- `cargo check --manifest-path src-tauri/Cargo.toml` — `src-tauri` is intentionally outside the workspace (it needs the libs above)
- `node tools/find-decomps/find-decomps.mjs --query "<game>" [--deep]` — discovers decomps on GitHub

## Layout
- `crates/vapor-core` — all business logic: manifest, blocklist, catalog, saves. No Tauri.
- `crates/vapor-cli` — the `vapor` binary (validate/index).
- `src-tauri/src/commands.rs` — thin layer over the core; do not put business logic here.
- `src/` — React UI; `src/api.ts` mirrors the Tauri commands.
- `games/<slug>/game.json` — the catalog. `schema/game.schema.json` describes the format (the real validation is `GameManifest::validate`).
- `takedown/` — policy (`TAKEDOWN.md`) and `blocklist.json`.
- `.github/workflows/` — `ci.yml`, `catalog.yml` (publishes `catalog.json` to the `catalog` branch).
- Game artifacts do NOT live here: builds and Releases live in `lucasgmagalhaes/vapor-artifacts` (one `build-<slug>.yml` workflow per game). Releases in this repository are app versions only (`v*`).

## Rules that must not break
- The repository holds metadata only. Never commit binaries, ROMs or assets; in `games/` only `game.json` and `cover.webp` (CI rejects anything else).
- `assets_policy` is `open` or `bring-your-own`. Commercial games with bundled assets are not accepted. BYO: the player's files never leave their machine.
- Every downloaded artifact goes through `verify_artifact` (size + SHA-256) before being written or executed.
- Saves belong to the player: a takedown removes the game from disk, never the saves. Save/file paths are always validated (no `..`, no absolute paths, no `\`).
- Never invent URLs, hashes or licenses in manifests. If real data is missing, ask.
- A takedown = `git rm -r games/<slug>` + an entry in `takedown/blocklist.json` (slug, sha256 and/or domain, date, reference).

## State and pending work
- `src-tauri` has not been compiled anywhere yet; expect errors on the first `cargo check` with the libs installed.
- `install_game` only downloads and stores `artifact.bin`: still missing safe unzipping, serving in an isolated webview, and wiring the wasm virtual FS to `SaveStore`.
- `games/doom-freedoom/game.json` points to the `vapor-artifacts` Release. `games/demo-game` is only an example (fake URL).
- Goal: Resident Evil 1 via our own decomp, in a separate repository, as `bring-your-own`.

## Conventions
- Write code, comments, docs, commit messages and replies in English.
- Short commits on their own branch; do not merge to `main` or open a PR unless explicitly asked.
- Run `cargo test --workspace` and `pnpm build` before committing.
