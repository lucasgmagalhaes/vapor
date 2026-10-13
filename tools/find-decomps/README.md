# find-decomps

Descobre no GitHub projetos de decompilação de jogos candidatos a port para wasm.

```sh
node tools/find-decomps/find-decomps.mjs --query "resident evil" --deep
GITHUB_TOKEN=... node tools/find-decomps/find-decomps.mjs --min-stars 50 --limit 20 --json > candidatos.json
```

Pontuação: estrelas, licença presente, sinais de wasm/emscripten/SDL, indícios de "bring your own assets" e atividade recente.
Os sinais são heurísticos. **Todo candidato precisa de revisão humana** (licença do código, política de assets e risco de takedown) antes de virar `games/<slug>/game.json`.
