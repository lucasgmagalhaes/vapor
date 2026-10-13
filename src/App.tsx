import { useCallback, useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, ExternalEntry, Game, SystemInfo } from "./api";
import { GameDetail } from "./detail";
import { HeroCarousel, Slide } from "./hero";
import { NativeDetail, availability, groupLinks, label, verdict } from "./native";
import { EMPTY, Progress, ProgressEvent, apply, load as loadProgress, store as storeProgress } from "./progress";
import { GamificationBar, NavigationHeader, Sidebar, View } from "./shell";
import { Cover, GameGrid, Item, Modal, SectionHeader } from "./ui";

const norm = (s: string) => s.toLowerCase();

function matches(i: Item, q: string) {
  const n = norm(q.trim());
  return !n || [i.title, i.subtitle, ...i.tags].some((t) => norm(t).includes(n));
}

export function App() {
  const [games, setGames] = useState<Game[]>([]);
  const [installed, setInstalled] = useState<string[]>([]);
  const [links, setLinks] = useState<ExternalEntry[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("home");
  const [category, setCategory] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [opened, setOpened] = useState<Item | null>(null);
  const [progress, setProgress] = useState<Progress>(() => loadProgress());

  const load = useCallback(async () => {
    setGames(await api.getCatalog(query));
    setInstalled(await api.installedGames());
    setLinks(await api.getLinks());
    setSystem(await api.getSystem());
  }, [query]);

  useEffect(() => {
    load().catch((e) => setStatus(String(e)));
  }, [load]);

  const run = async (text: string, fn: () => Promise<unknown>, event?: ProgressEvent) => {
    setStatus(`${text}…`);
    try {
      await fn();
      setStatus("");
      if (event) {
        setProgress((p) => {
          const next = apply(p, event, new Date());
          storeProgress(next);
          return next;
        });
      }
      await load();
    } catch (e) {
      setStatus(`Error: ${e}`);
    }
  };

  const refresh = () =>
    run("Refreshing catalog", async () => {
      const r = await api.refreshCatalog();
      const notes = [
        r.removed.length ? `Removed from catalog: ${r.removed.join(", ")}` : "",
        r.rejected.length ? `Ignored ${r.rejected.length} invalid catalog entr${r.rejected.length === 1 ? "y" : "ies"}` : "",
      ].filter(Boolean);
      setStatus(notes.join(". "));
    });

  // The catalog is cached on disk; fetch the published one once at startup so covers, new links and
  // takedowns show up without a manual click. Offline is fine: the cache stays.
  useEffect(() => {
    api.refreshCatalog().then(() => load()).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => groupLinks(links), [links]);

  const wasmItems: Item[] = useMemo(
    () =>
      games.map((g) => ({
        key: `w:${g.slug}`,
        title: g.title,
        subtitle: g.authors.join(", "),
        cover: g.cover,
        tags: g.tags,
        kind: "wasm" as const,
        badge: installed.includes(g.slug) ? { text: "Installed", tone: "ok" as const } : { text: "WASM", tone: "muted" as const },
      })),
    [games, installed],
  );

  const nativeItems: Item[] = useMemo(() => {
    if (!system) return [];
    return groups.map((entries) => {
      const a = availability(entries, system);
      const shown = a.variant ?? entries[0];
      return {
        key: `n:${shown.group ?? shown.slug}`,
        title: shown.title,
        subtitle: shown.publisher,
        cover: shown.cover,
        tags: [...new Set(entries.flatMap((e) => e.tags))],
        kind: "native" as const,
        badge: verdict(a.kind, system),
        unavailable: a.kind === "unavailable" || a.kind === "cannot-run",
      };
    });
  }, [groups, system]);

  const everything = useMemo(() => [...wasmItems, ...nativeItems].filter((i) => matches(i, query)), [wasmItems, nativeItems, query]);

  const open = (i: Item) => setOpened(i);

  const tags = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const i of [...wasmItems, ...nativeItems]) for (const t of i.tags) m.set(t, [...(m.get(t) ?? []), i]);
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [wasmItems, nativeItems]);

  const slides: Slide[] = useMemo(() => {
    const out: Slide[] = [];
    for (const g of games.filter((x) => x.cover)) {
      const isIn = installed.includes(g.slug);
      const item = wasmItems.find((i) => i.key === `w:${g.slug}`)!;
      out.push({
        key: item.key,
        title: g.title,
        summary: `Runs right here, no setup. By ${g.authors.join(", ")}.`,
        cover: g.cover,
        badge: "WebAssembly",
        primary: isIn
          ? { label: "Play now", play: true, onClick: () => run("Starting", () => api.playGame(g.slug), { type: "play", slug: g.slug }) }
          : { label: "Install", onClick: () => run("Downloading and verifying", () => api.installGame(g.slug), { type: "install", slug: g.slug }) },
        secondary: { label: "View details", onClick: () => open(item) },
      });
    }
    for (const entries of groups) {
      const shown = (system && availability(entries, system).variant) ?? entries[0];
      const item = nativeItems.find((i) => i.key === `n:${shown.group ?? shown.slug}`);
      if (!item || !shown.cover) continue;
      out.push({
        key: item.key,
        title: shown.title,
        summary: shown.summary,
        cover: shown.backdrop ?? shown.cover,
        fallbackCover: shown.cover,
        badge: "Native port",
        primary: { label: "View details", onClick: () => open(item) },
        secondary: { label: "Original source", onClick: () => openUrl(shown.url) },
      });
    }
    return out.slice(0, 5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games, installed, groups, system, wasmItems, nativeItems]);

  const detail = () => {
    if (!opened || !system) return null;
    if (opened.kind === "wasm") {
      const g = games.find((x) => `w:${x.slug}` === opened.key);
      return g ? <GameDetail game={g} installed={installed.includes(g.slug)} run={run} /> : null;
    }
    const entries = groups.find((e) => `n:${e[0].group ?? e[0].slug}` === opened.key);
    return entries ? <NativeDetail entries={entries} system={system} run={run} /> : null;
  };

  const categoryTiles = (
    <div className="category-grid">
      {tags.map(([tag, list]) => (
        <button
          key={tag}
          className="category"
          onClick={() => {
            setCategory(tag);
            setView("categories");
          }}
        >
          <Cover src={list.find((i) => i.cover)?.cover} title={tag} className="category-image" />
          <span className="category-shade" />
          <span className="category-name">{tag}</span>
          <span className="category-count">{list.length} {list.length === 1 ? "game" : "games"}</span>
        </button>
      ))}
    </div>
  );

  const empty = (text: string) => <p className="empty">{text}</p>;
  const featured = wasmItems.filter((i) => matches(i, query));
  const natives = nativeItems.filter((i) => matches(i, query));

  let body;
  switch (view) {
    case "home":
      body = (
        <>
          <HeroCarousel slides={slides} />
          {featured.length > 0 && (
            <section className="block">
              <SectionHeader title="Featured games" action={{ label: "See all", onClick: () => setView("explore") }} />
              <GameGrid items={featured.slice(0, 6)} open={open} />
            </section>
          )}
          {natives.length > 0 && (
            <section className="block">
              <SectionHeader title="Native ports" action={{ label: "See all", onClick: () => setView("explore") }} />
              <p className="muted note">
                Your system: <strong>{system ? `${label(system.os)} (${system.arch})` : "…"}</strong>. These games are
                not WebAssembly: they run as normal programs and are not hosted by Vapor.
              </p>
              <GameGrid items={natives.slice(0, 6)} open={open} />
            </section>
          )}
          {tags.length > 0 && (
            <section className="block">
              <SectionHeader title="Categories" action={{ label: "See all", onClick: () => { setCategory(null); setView("categories"); } }} />
              {categoryTiles}
            </section>
          )}
          {featured.length + natives.length === 0 && empty("The catalog is empty. Use the refresh button at the top right.")}
        </>
      );
      break;
    case "explore":
      body = (
        <section className="block">
          <h1 className="page-title">Explore</h1>
          {everything.length ? <GameGrid items={everything} open={open} /> : empty("No games match your search.")}
        </section>
      );
      break;
    case "categories": {
      const list = category ? [...wasmItems, ...nativeItems].filter((i) => i.tags.includes(category) && matches(i, query)) : [];
      body = (
        <section className="block">
          <h1 className="page-title">{category ?? "Categories"}</h1>
          {category ? (
            <>
              <button className="link back" onClick={() => setCategory(null)}>All categories</button>
              {list.length ? <GameGrid items={list} open={open} /> : empty("Nothing in this category matches your search.")}
            </>
          ) : tags.length ? (
            categoryTiles
          ) : (
            empty("No categories yet.")
          )}
        </section>
      );
      break;
    }
    case "collection": {
      const mine = wasmItems.filter((i) => installed.includes(i.key.slice(2)) && matches(i, query));
      body = (
        <section className="block">
          <h1 className="page-title">Collection</h1>
          {mine.length ? <GameGrid items={mine} open={open} /> : empty("Games you install appear here.")}
        </section>
      );
      break;
    }
    case "downloads":
      body = (
        <section className="block">
          <h1 className="page-title">Downloads</h1>
          <div className="panel">
            <h3>Now</h3>
            <p>{status && !status.startsWith("Error") ? status : "Nothing is downloading."}</p>
          </div>
          <div className="panel">
            <h3>Installed on this computer</h3>
            {installed.length ? (
              <ul className="plain">
                {installed.map((slug) => (
                  <li key={slug} className="row spread">
                    <span>{games.find((g) => g.slug === slug)?.title ?? slug}</span>
                    <button className="btn" onClick={() => run("Uninstalling", () => api.uninstallGame(slug))}>Uninstall</button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No game installed.</p>
            )}
          </div>
        </section>
      );
      break;
    default:
      body = (
        <section className="block">
          <h1 className="page-title">Settings</h1>
          <div className="panel">
            <h3>This computer</h3>
            <p>{system ? `${label(system.os)} (${system.arch})${system.native_ok ? "" : " – native ports cannot run here"}` : "…"}</p>
          </div>
          <div className="panel">
            <h3>Catalog</h3>
            <p className="muted">{games.length} browser games, {groups.length} linked native games.</p>
            <button className="btn" onClick={refresh}>Refresh catalog</button>
          </div>
          <div className="panel">
            <h3>Progress</h3>
            <p className="muted">XP, streak and achievements are kept on this computer only.</p>
            <button
              className="btn danger"
              onClick={() => {
                if (window.confirm("Reset your level, streak and achievements?")) {
                  storeProgress(EMPTY);
                  setProgress(EMPTY);
                }
              }}
            >
              Reset progress
            </button>
          </div>
        </section>
      );
  }

  return (
    <div className="shell">
      <GamificationBar progress={progress} onRefresh={refresh} />
      <NavigationHeader view={view} setView={(v) => { setView(v); if (v !== "categories") setCategory(null); }} query={query} setQuery={setQuery} />
      <div className="frame">
        <Sidebar view={view} setView={(v) => { setView(v); if (v !== "categories") setCategory(null); }} />
        <main className="content">
          {status && <p className={`status${status.startsWith("Error") ? " error" : ""}`} role="status">{status}</p>}
          {body}
        </main>
      </div>
      {opened && <Modal onClose={() => setOpened(null)}>{detail()}</Modal>}
    </div>
  );
}
