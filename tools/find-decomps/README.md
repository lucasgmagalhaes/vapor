# find-decomps

Discovers game decompilation projects on GitHub that are candidates for a wasm port.

```sh
node tools/find-decomps/find-decomps.mjs --query "resident evil" --deep
GITHUB_TOKEN=... node tools/find-decomps/find-decomps.mjs --min-stars 50 --limit 20 --json > candidates.json
```

Scoring: stars, license present, wasm/emscripten/SDL signals, hints of "bring your own assets", and recent activity.
The signals are heuristic. **Every candidate needs human review** (code license, asset policy and takedown risk) before it becomes `games/<slug>/game.json`.

## Weekly report (`report.mjs`)
`node tools/find-decomps/report.mjs [--query "term"]` runs the search for every entry of `watchlist.json` and prints a Markdown report, skipping repositories listed under `reviewed`. The `discover-decomps` workflow runs it every Monday (or on demand) and keeps the result in one open issue labelled `discovery`.

It only lists public source repositories. It does not look for ROMs, disc images or any other copyrighted assets: the player supplies those (`bring-your-own`), and their hashes come from the manifest.
