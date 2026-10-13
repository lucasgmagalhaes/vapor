# From discovery to the catalog

Everything runs in GitHub Actions; a person only decides at the two marked points.

```
crawl.yml (every 4 h)                                       tools/crawler
  1. discover      GitHub search by topic (serial: API limit)
  2. inspect       4 parallel blobless clones: license, wasm signals,
                   supply-chain flags (binaries, pipe-to-shell, odd submodules),
                   duplicates against games/ and candidates/
  3. asset audit   shallow clone + license-audit.mjs: which license covers each asset byte?
                   ready-to-build | needs-asset-audit | blocked        -> crawler-data branch
                                  |
        [HUMAN 1] read the license files of the candidates you want; reject or approve
                                  |
  4. build         gen-build.mjs writes build-<slug>.yml for vapor-artifacts (pinned commit,
                   Emscripten, build outputs + license texts only, `vapor audit --scan-only`)
                   -> Release <slug>-<run>  (zip + sha256 + size)
                                  |
pipeline.yml (manual dispatch with the Release tag)         tools/pipeline
  5. audit         `vapor audit`: executables, wasm, miners, eval, hosts (blocks stop the run)
  6. smoke test    real browser under the game window's CSP: loads? errors? what does it write
                   (infers saves.paths)?
  7. manifest      games/<slug>/game.json + audits/<slug>.json from verified values only
  8. pull request  (ready for review) with the audit output and a reviewer checklist
                                  |
        [HUMAN 2] read the PR, merge
                                  |
ci.yml on the PR   validate (duplicates, artifact origin, audit record) + re-download and
                   re-audit every listed artifact
catalog.yml        publishes catalog.json; the app installs it, scans it again, runs it in an
                   isolated window with no network
```

## What is automatic and what is not
- **Automatic**: discovery, license triage, the security scan (three times: in the build, in the PR
  and at install time), smoke testing, hashing, manifest assembly, duplicate detection.
- **Human**: the license decision and the merge. The license audit is a heuristic: `ready-to-build`
  means "nothing found against it and every asset has a license in its own tree", not "legal".
  Publishing third-party code and assets carries legal risk that no scanner removes.
- **Needs a person's one-off setup**: Actions must be allowed to create pull requests (repository
  settings), and writing `build-<slug>.yml` into `vapor-artifacts` needs a token with access to that
  repository (not wired yet; run `gen-build.mjs` by hand until then).

## Limits
- The generated build recipe works only for projects that already support Emscripten; others stay
  `needs-port`. The first run of a generated workflow decides whether it works.
- The smoke test proves "loads and does not crash for a few seconds", not "is playable".
- `saves.paths` is inferred broadly (for example `/libsdl`); narrow it by hand when possible.

## Commands
```sh
node tools/crawler/crawl.mjs --max-new 30 [--concurrency 4] [--no-asset-audit]
node tools/crawler/summary.mjs crawl-output
node tools/pipeline/gen-build.mjs --candidate crawl-output/Owner__repo.json --slug my-game --checkout <clone>
node tools/pipeline/smoke.mjs <extracted dir> <entry> [--channel chrome|chromium]
node tools/pipeline/make-manifest.mjs --candidate ... --slug ... --title ... --entry ... --tag ...
cargo run -q -p vapor-cli -- audit <zip> --slug <slug> [--accept r1,r2 --notes "why" --write]
```
