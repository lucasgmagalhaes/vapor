# find-decomps

Discovers game decompilation projects on GitHub that are candidates for a wasm port.

```sh
node tools/find-decomps/find-decomps.mjs --query "resident evil" --deep
GITHUB_TOKEN=... node tools/find-decomps/find-decomps.mjs --min-stars 50 --limit 20 --json > candidates.json
```

Scoring: stars, license present, wasm/emscripten/SDL signals, hints of "bring your own assets", and recent activity.
The signals are heuristic. **Every candidate needs human review** (code license, asset policy and takedown risk) before it becomes `games/<slug>/game.json`.
