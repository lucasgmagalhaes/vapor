# Contribuindo

## Adicionar um jogo
1. Crie `games/<slug>/game.json` seguindo `schema/game.schema.json` (veja `games/demo-game`).
2. `assets_policy` deve ser `open` ou `bring-your-own`. Jogos comerciais com assets embutidos **não** são aceitos.
3. Hospede o artefato você mesmo (HTTPS) e informe `sha256` e `size` corretos.
4. Rode `cargo run -p vapor-cli -- validate .` e abra o PR.

## Remover um jogo
Apague `games/<slug>/` (e, se for takedown, adicione em `takedown/blocklist.json`).

## Desenvolvimento
- `pnpm install && pnpm tauri dev` (Linux precisa de libwebkit2gtk-4.1-dev e libgtk-3-dev)
- `cargo test --workspace` testa o núcleo (`crates/vapor-core`), sem dependências de sistema.
