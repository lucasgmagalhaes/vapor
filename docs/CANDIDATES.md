# Game candidates

Survey of games that could be added to the catalog, checked on 2026-10-13 by reading the
license files in each project's repository at the commit shown. This is a technical check,
not legal advice. A license file can be wrong or incomplete, so re-check before writing a
`game.json`.

How to read the table:
- **Code** and **assets** are licensed separately and are listed separately.
- **Wasm** says whether the upstream repository itself contains an Emscripten build path.
- "Not found" means I looked in the repository and found nothing, not that no port exists.
- Nothing here was built or run.

## Verified candidates

| Game | Commit | Code | Free assets | Wasm | Verdict |
|---|---|---|---|---|---|
| [OpenTTD](https://github.com/OpenTTD/OpenTTD) | `daa6e1c` | GPL (`COPYING.md`) | OpenGFX (GPL-2.0), OpenMSX (GPL-2.0), OpenSFX (CC BY-SA 3.0) | Yes: `os/emscripten/` with a Dockerfile and build README; CMake preloads the baseset | **Best candidate** |
| [Neverball](https://github.com/Neverball/neverball) | `8288383` | GPL-2.0-or-later (`LICENSE.md`) | **Not documented** | Yes: top-level `emscripten/` (Dockerfile, `ball.mk`, `mapc.mk`) and `__EMSCRIPTEN__` in `ball/main.c` | Good, after an asset audit |
| [SuperTux](https://github.com/SuperTux/supertux) | `b562c6c` | GPL-3.0 (`LICENSE.txt`) | "Most of the data subdirectory" is CC-BY-SA (`README.md`) | Partial: `__EMSCRIPTEN__` guards in `src/`, but no build instructions found | Possible, needs audit and a build |
| [OpenTyrian](https://github.com/opentyrian/opentyrian) | `624e2f2` | GPL-2.0 (`COPYING`) | Tyrian 2.1 data, described as "freeware" in the README | Not found upstream | Blocked on the data license |
| [Dungeon Crawl Stone Soup](https://github.com/crawl/crawl) | `d7385f5` | GPL-2.0 (`LICENSE`) | "Majority" of tiles are CC0; older pieces may differ | Not found | Heavy port, not now |
| [Luanti](https://github.com/luanti-org/luanti) | `5bb520b` | LGPL-2.1 | CC BY-SA 3.0 / 4.0 with listed exceptions (`LICENSE.txt`) | Not found | Not now |
| [Freeserf](https://github.com/freeserf/freeserf) | `bb64ea2` | GPL-3.0 | None: needs the original Settlers data files | Not found upstream | Bring-your-own only |

### Notes per game

**OpenTTD.** Everything needed to play is freely licensed: the game and OpenGFX/OpenMSX are
GPL, and OpenSFX is CC BY-SA 3.0 (so keep its attribution and share-alike notice in the
package). The upstream README documents an Emscripten build (host tools first, then the game),
and `CMakeLists.txt` preloads `baseset/` into the virtual filesystem. The package must bundle
OpenGFX, OpenSFX and OpenMSX, which are separate repositories to be pinned by commit. Still to
do: decide which files are saves (OpenTTD keeps them in a `save` folder) and check the size.

**Neverball.** The code license is clear, but `LICENSE.md` says nothing about the license of
`data/` (levels, textures, sounds, music). The only asset statements are about fonts and the
Octocat ball (`doc/legal/license-octocat.md`), which is a permission from GitHub, not an open
license. Before adding it: find the license of each part of `data/` (authors, `git log`, ask the
maintainers), and drop the Octocat ball from the package. If the audit is unclear, do not list it
as `open`.

**SuperTux.** The README says most of `data/` is CC-BY-SA, so some files are not. The repository
is about 600 MB (mostly data), which is a problem for an in-app download. The Emscripten guards
suggest a web build exists, but I did not find the commands to produce it.

**OpenTyrian.** The README says the Tyrian 2.1 data was "released as freeware" and points to a
download URL. I could not read that file or any grant text (the host was unreachable from this
environment). Freeware is not an open license, so I would not list it until the exact
redistribution terms are found and written down. The `midzer/opentyrian` fork (listed in
awesome-emscripten) contains no build files for the web.

**Dungeon Crawl Stone Soup.** The LICENSE itself warns that tile licensing "may be complex,
especially for older pieces" and points to `github.com/crawl/tiles`. The project has a web
frontend that uses a server, not a wasm build.

**Luanti.** Licenses are well documented, but I found no Emscripten path, and a port would be a
large project.

**Freeserf.** Only fits as `bring-your-own`: the README tells the player to supply the original
`SPAE.PA`-style data file. The `midzer/freeserf` fork is listed in awesome-emscripten, but I did
not examine it.

## Not examined

These came up in searches or in awesome lists, but I did not read their repositories or
licenses. Treat everything about them as unknown:

- OpenArena content, Cube 2: Sauerbraten, Xonotic, 0 A.D., Battle for Wesnoth
- Quake ports ([Quake-WASM](https://github.com/GMH-Code/Quake-WASM), Quake 3), [D3Wasm](https://github.com/gabrielcuvillier/d3wasm): engines are GPL but the game data is proprietary, so these would be bring-your-own
- Only the OpenArena **engine** repository (`OpenArena/engine`, `95c6342`, GPL-2.0) was cloned; it is an ioquake3 fork with no Emscripten path, and the game content lives elsewhere.

## Excluded

- Games built on third-party IP even when the code is free (for example Sonic fan games).
- Freeware games with no license grant, such as the PICO-8 port of Celeste Classic.

## Suggested order

1. **OpenTTD**: free code, free assets and an upstream wasm build.
2. **Neverball**: wasm build exists; blocked only by the asset audit.
3. **SuperTux**: after an asset audit, a confirmed build, and a size check.

For each: add a `build-<slug>.yml` workflow to `vapor-artifacts` that pins the source commit and
verifies asset hashes (see the Doom workflow), then write the `game.json` from the published
Release.
