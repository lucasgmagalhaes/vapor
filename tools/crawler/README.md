# Candidate crawler

Finds decompilation and recompilation projects for released games, plus game-specific native
ports that may qualify as links to their original source, and records what
it learns, so a human can review them. It **never writes to `games/`**.

```sh
node tools/crawler/crawl.mjs --max-new 15          # one pass
node tools/crawler/crawl.mjs --watch --interval 3600   # keeps running
```

Options: `--out` (default `crawl-output`), `--curated` (default `candidates`), `--max-new`, `--concurrency` (parallel clones, default 4),
`--min-stars`, `--refresh-days`, `--watch`, `--interval`. A `GITHUB_TOKEN` raises the search rate
limit; an invalid token silently falls back to anonymous mode.

## How it works
1. **Discover** via GitHub search for decompilation, reverse engineering, recompilation and
   game-specific native ports, dropping engines, frameworks, tutorials and other noise. Eight
   search requests run without a fixed delay. Forks are included because some maintained ports
   are forks. `seeds.json` names specific GitHub repositories worth inspecting even when their
   GitHub description and topics are empty.
2. **Inspect** each new or changed repo with a blobless shallow `git clone` (no REST quota): file
   tree, README, LICENSE. The code license comes from GitHub's detection. Distribution evidence
   can be a supported store link in the README or homepage, or a reviewed publisher source in
   `release-evidence.json` for historical console games whose repositories have no store link.
3. **Verify distribution** against the live store or reviewed publisher release evidence. Steam requires a released `game` product and
   a matching title in the repository text. Epic and console product pages with matching titles
   are marked `review`: a person must confirm the release and project identity. Missing evidence
   gets `distribution-unverified`. Both are omitted from `index.json` and appear in `review.json`.
   Reviewed evidence is tied to an exact repository and official source, and the claimed title
   must appear in that repository's text. Adding evidence requires a person to check the source.
4. **Classify** verified decompilations into `needs-asset-audit`, `byo-only`, `needs-port` or
   `rejected` with reasons. Decompilation projects are treated as bring-your-own. Native ports
   are `external-only`: they cannot run in Vapor's WebAssembly player or be mirrored.
5. **Write** one JSON record per repo plus `index.json` and `review.json` to `crawl-output/`. State for incremental
   runs is kept in `state.json`.

Each run logs search counts and timings, queue decisions, per-repository classification and
distribution evidence, asset audits, errors and final totals. The scheduled workflow also saves
the console output as `crawl-output/crawl.log` on the `crawler-data` branch.

The crawler currently searches GitHub repositories. A standalone itch.io release such as
Azimuth requires a separate source adapter and is outside this crawler's discovery scope.

## Curated records
`candidates/` holds hand-reviewed records (`"manual": true`, with the license files read at a
pinned commit; see `docs/CANDIDATES.md`). The crawler skips any repo that has one. Extra statuses
used there: `listed`, `ready-to-build` and `blocked`.

## Scheduled run
`.github/workflows/crawl.yml` runs every 4 hours, publishes `crawl-output/` to the `crawler-data`
branch (state included, so runs are incremental), then opens eligible link PRs and dispatches the
game PR pipeline for new built Releases. A manual run performs both steps; `only=releases` skips the
crawl and checks existing crawler data.
Records written before distribution verification are refreshed incrementally; the PR creator
skips them until they contain verified game evidence.

## Limits
The signals are heuristics from text and file names. A storefront match does not prove that the
repository implements the linked game; a reviewer must check that relationship. A `needs-asset-audit` record means "worth
looking at", never "safe to list". Asset licenses must be verified file by file before a game gets
`assets_policy: "open"`.
