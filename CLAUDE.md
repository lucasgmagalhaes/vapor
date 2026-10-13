# Vapor

App desktop (Tauri 2: Rust + React/TypeScript/Vite) que é uma "Steam" de jogos decompilados/portados para WebAssembly: catálogo aberto + gerência de saves do jogador. Repositório público; contribuir é abrir PR; remover um jogo tem que ser trivial (risco de direitos autorais).

## Comandos
- `cargo test --workspace` — núcleo e CLI (sem libs de sistema)
- `cargo run -p vapor-cli -- validate .` — valida `games/*/game.json` e a blocklist (a CI roda isto)
- `cargo run -p vapor-cli -- index .` — gera `catalog.json` (ignorado pelo git)
- `pnpm install && pnpm build` — front (tsc + vite)
- `pnpm tauri dev` — app completo. Linux precisa de `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`
- `cargo check --manifest-path src-tauri/Cargo.toml` — `src-tauri` fica fora do workspace de propósito (precisa das libs acima)
- `node tools/find-decomps/find-decomps.mjs --query "<jogo>" [--deep]` — descobre decomps no GitHub

## Estrutura
- `crates/vapor-core` — toda a regra de negócio: manifesto, blocklist, catálogo, saves. Sem Tauri.
- `crates/vapor-cli` — binário `vapor` (validate/index).
- `src-tauri/src/commands.rs` — camada fina sobre o core; não coloque regra de negócio aqui.
- `src/` — UI React; `src/api.ts` espelha os comandos Tauri.
- `games/<slug>/game.json` — o catálogo. `schema/game.schema.json` descreve o formato (a validação real é `GameManifest::validate`).
- `takedown/` — política (`TAKEDOWN.md`) e `blocklist.json`.
- `.github/workflows/` — `ci.yml`, `catalog.yml` (publica `catalog.json` na branch `catalog`).
- Artefatos dos jogos NÃO ficam aqui: o build e os Releases vivem em `lucasgmagalhaes/vapor-artifacts` (um workflow `build-<slug>.yml` por jogo). Os Releases deste repositório são só versões do app (`v*`).

## Regras que não podem quebrar
- O repositório guarda só metadados. Nunca commite binários, ROMs ou assets; em `games/` só `game.json` e `cover.webp` (a CI rejeita o resto).
- `assets_policy` é `open` ou `bring-your-own`. Jogo comercial com assets embutidos não entra. BYO: os arquivos do jogador nunca saem da máquina dele.
- Todo artefato baixado passa por `verify_artifact` (tamanho + SHA-256) antes de ser gravado ou executado.
- Saves são do jogador: um takedown remove o jogo do disco, nunca os saves. Caminhos de save/arquivo são sempre validados (sem `..`, sem absolutos, sem `\`).
- Não invente URLs, hashes ou licenças em manifestos. Se faltar dado real, pergunte.
- Um takedown = `git rm -r games/<slug>` + entrada em `takedown/blocklist.json` (slug, sha256 e/ou domínio, data, referência).

## Estado e pendências
- `src-tauri` ainda não foi compilado em lugar nenhum; espere erros no primeiro `cargo check` com as libs instaladas.
- `install_game` só baixa e guarda `artifact.bin`: falta descompactar com segurança, servir em webview isolada e ligar o FS virtual do wasm ao `SaveStore`.
- `games/doom-freedoom/game.json` aponta para o Release do `vapor-artifacts`. `games/demo-game` é só exemplo (URL fictícia).
- Meta: Resident Evil 1 via decomp próprio, em repositório separado, como `bring-your-own`.

## Convenções
- Responda e documente em português. Commits curtos, em branch própria; não faça merge na `main` nem abra PR sem pedido explícito.
- Rode `cargo test --workspace` e `pnpm build` antes de commitar.
