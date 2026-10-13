# Contributing

## Adding a game
1. Create `games/<slug>/game.json` following `schema/game.schema.json` (see `games/demo-game`).
2. `assets_policy` must be `open` or `bring-your-own`. Commercial games with bundled assets are **not** accepted.
3. Host the artifact yourself (HTTPS) and provide the correct `sha256` and `size`.
4. Run `cargo run -p vapor-cli -- validate .` and open the PR.

## Removing a game
Delete `games/<slug>/` (and, for a takedown, add it to `takedown/blocklist.json`).

## Development
- `pnpm install && pnpm tauri dev` (Linux needs libwebkit2gtk-4.1-dev and libgtk-3-dev)
- `cargo test --workspace` tests the core (`crates/vapor-core`), with no system dependencies.
