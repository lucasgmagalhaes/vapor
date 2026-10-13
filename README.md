# Vapor

Biblioteca de jogos decompilados para WebAssembly, com catálogo aberto e gerenciamento de saves do jogador.
App desktop: **Tauri 2** (Rust) + **React + TypeScript + Vite**.

- `games/` catálogo (um `game.json` por jogo; só metadados, nunca binários)
- `crates/vapor-core` manifestos, blocklist, catálogo e saves (testado, sem Tauri)
- `crates/vapor-cli` `vapor validate|index` (CI)
- `src-tauri/` shell Tauri (comandos finos sobre o core)
- `src/` interface React
- `takedown/` política e blocklist de remoção

Veja `docs/CONTRIBUTING.md` e `takedown/TAKEDOWN.md`.
