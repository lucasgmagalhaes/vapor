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

See `docs/CONTRIBUTING.md` and `takedown/TAKEDOWN.md`.
