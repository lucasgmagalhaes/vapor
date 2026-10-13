# Vapor

A library of games decompiled to WebAssembly, with an open catalog and player save management.
Desktop app: **Tauri 2** (Rust) + **React + TypeScript + Vite**.

- `games/` — the catalog (one `game.json` per game; metadata only, never binaries)
- `crates/vapor-core` — manifests, blocklist, catalog and saves (tested, no Tauri)
- `crates/vapor-cli` — `vapor validate|index` (CI)
- `backend/` — Tauri shell (thin commands over the core)
- `src/` — React UI
- `takedown/` — takedown policy and blocklist
- Game artifacts (build + Releases): [vapor-artifacts](https://github.com/lucasgmagalhaes/vapor-artifacts)

## Run it
```sh
make dev     # opens the desktop app (installs frontend dependencies first)
make         # list every target: build, bundle, test, check, validate, index, audit-deps, clean
```
Needs Rust, Node 22 and the Tauri prerequisites (Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev
libayatana-appindicator3-dev librsvg2-dev`). If the `pnpm` on your PATH is broken, the Makefile uses
`npx pnpm@10` by itself.

See `docs/CONTRIBUTING.md` and `takedown/TAKEDOWN.md`.
