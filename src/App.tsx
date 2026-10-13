import { useCallback, useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, Game, SaveMeta } from "./api";

export function App() {
  const [games, setGames] = useState<Game[]>([]);
  const [installed, setInstalled] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Game | null>(null);
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    setGames(await api.getCatalog(query));
    setInstalled(await api.installedGames());
  }, [query]);

  useEffect(() => {
    load().catch((e) => setStatus(String(e)));
  }, [load]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setStatus(`${label}…`);
    try {
      await fn();
      setStatus("");
      await load();
    } catch (e) {
      setStatus(`Error: ${e}`);
    }
  };

  const refresh = () =>
    run("Refreshing catalog", async () => {
      const r = await api.refreshCatalog();
      setStatus(r.removed.length ? `Removed from catalog: ${r.removed.join(", ")}` : "");
    });

  return (
    <div className="app">
      <header>
        <h1>Vapor</h1>
        <input
          placeholder="Search games…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button onClick={refresh}>Refresh catalog</button>
      </header>
      {status && <p className="status">{status}</p>}
      <main>
        <ul className="grid">
          {games.map((g) => (
            <li key={g.slug} onClick={() => setSelected(g)}>
              <strong>{g.title}</strong>
              <small>{g.authors.join(", ")}</small>
              {installed.includes(g.slug) && <span className="badge">installed</span>}
            </li>
          ))}
          {games.length === 0 && <li className="empty">Catalog is empty. Click “Refresh catalog”.</li>}
        </ul>
        {selected && (
          <GameDetail
            game={selected}
            installed={installed.includes(selected.slug)}
            run={run}
          />
        )}
      </main>
    </div>
  );
}

function GameDetail(props: {
  game: Game;
  installed: boolean;
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const { game, installed, run } = props;
  const [saves, setSaves] = useState<SaveMeta[]>([]);

  const reload = useCallback(() => {
    api.listSaves(game.slug).then(setSaves).catch(() => setSaves([]));
  }, [game.slug]);
  useEffect(reload, [reload]);

  return (
    <aside>
      <h2>{game.title}</h2>
      <p>
        License: {game.license.code} · Assets:{" "}
        {game.assets_policy === "bring-your-own" ? "bring your own (BYO)" : "open"}
      </p>
      <p>
        <a href={game.source.repo} target="_blank" rel="noreferrer">source code</a> · contact: {game.contact}
      </p>
      {installed ? (
        <>
          <button onClick={() => run("Starting", () => api.playGame(game.slug))}>Play</button>
          <button onClick={() => run("Uninstalling", () => api.uninstallGame(game.slug))}>
            Uninstall
          </button>
        </>
      ) : (
        <button onClick={() => run("Downloading and verifying", () => api.installGame(game.slug))}>
          Install
        </button>
      )}

      <h3>Saves</h3>
      <ul>
        {saves.map((s) => (
          <li key={s.slot}>
            {s.slot} · rev {s.revision} · {new Date(s.created_at * 1000).toLocaleString()}
            <button
              onClick={async () => {
                const dest = await save({ defaultPath: `${s.slug}-${s.slot}.vsave` });
                if (dest) await run("Exporting", () => api.exportSave(s.slug, s.slot, dest));
              }}
            >
              Export
            </button>
          </li>
        ))}
        {saves.length === 0 && <li>No saves.</li>}
      </ul>
      <button
        onClick={async () => {
          const src = await open({ filters: [{ name: "Vapor save", extensions: ["vsave"] }] });
          if (typeof src === "string") {
            await run("Importing", () => api.importSave(src));
            reload();
          }
        }}
      >
        Import .vsave
      </button>
      <button
        onClick={async () => {
          await run("Deleting saves", () => api.deleteGameSaves(game.slug));
          reload();
        }}
      >
        Delete all saves
      </button>
    </aside>
  );
}
