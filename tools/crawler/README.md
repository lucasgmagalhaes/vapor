# Candidate crawler

Finds open-source games on GitHub that could be packaged for the Vapor catalog and records what
it learns, so a human can review them. It **never writes to `games/`**.

```sh
node tools/crawler/crawl.mjs --max-new 15          # one pass
node tools/crawler/crawl.mjs --watch --interval 3600   # keeps running
```

Options: `--out` (default `crawl-output`), `--curated` (default `candidates`), `--max-new`,
`--min-stars`, `--refresh-days`, `--watch`, `--interval`. A `GITHUB_TOKEN` raises the search rate
limit; an invalid token silently falls back to anonymous mode.

## How it works
1. **Discover** via GitHub search (emscripten/webassembly/decompilation/remake topics), dropping
   awesome-lists and other noise.
2. **Inspect** each new or changed repo with a blobless shallow `git clone` (no REST quota): file
   tree, README, LICENSE. The code license comes from GitHub's detection.
3. **Classify** into `needs-asset-audit`, `byo-only`, `needs-port` or `rejected` with reasons.
   Decompilation projects are always treated as bring-your-own.
4. **Write** one JSON record per repo plus `index.json` to `crawl-output/`. State for incremental
   runs is kept in `state.json`.

## Curated records
`candidates/` holds hand-reviewed records (`"manual": true`, with the license files read at a
pinned commit; see `docs/CANDIDATES.md`). The crawler skips any repo that has one. Extra statuses
used there: `listed`, `ready-to-build` and `blocked`.

## Scheduled run
`.github/workflows/crawl.yml` runs every 4 hours and publishes `crawl-output/` to the `crawler-data`
branch (state included, so runs are incremental).

## Limits
The signals are heuristics from text and file names. A `needs-asset-audit` record means "worth
looking at", never "safe to list". Asset licenses must be verified file by file before a game gets
`assets_policy: "open"`.
