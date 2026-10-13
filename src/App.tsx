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
      setStatus(`Erro: ${e}`);
    }
  };

  const refresh = () =>
    run("Atualizando catálogo", async () => {
      const r = await api.refreshCatalog();
      setStatus(r.removed.length ? `Removidos do catálogo: ${r.removed.join(", ")}` : "");
    });

  return (
    <div className="app">
      <header>
        <h1>Vapor</h1>
        <input
          placeholder="Buscar jogos…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button onClick={refresh}>Atualizar catálogo</button>
      </header>
      {status && <p className="status">{status}</p>}
      <main>
        <ul className="grid">
          {games.map((g) => (
            <li key={g.slug} onClick={() => setSelected(g)}>
              <strong>{g.title}</strong>
              <small>{g.authors.join(", ")}</small>
              {installed.includes(g.slug) && <span className="badge">instalado</span>}
            </li>
          ))}
          {games.length === 0 && <li className="empty">Catálogo vazio. Clique em “Atualizar catálogo”.</li>}
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
        Licença: {game.license.code} · Assets:{" "}
        {game.assets_policy === "bring-your-own" ? "traga os seus (BYO)" : "abertos"}
      </p>
      <p>
        <a href={game.source.repo} target="_blank" rel="noreferrer">código-fonte</a> · contato: {game.contact}
      </p>
      {installed ? (
        <button onClick={() => run("Desinstalando", () => api.uninstallGame(game.slug))}>
          Desinstalar
        </button>
      ) : (
        <button onClick={() => run("Baixando e verificando", () => api.installGame(game.slug))}>
          Instalar
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
                if (dest) await run("Exportando", () => api.exportSave(s.slug, s.slot, dest));
              }}
            >
              Exportar
            </button>
          </li>
        ))}
        {saves.length === 0 && <li>Nenhum save.</li>}
      </ul>
      <button
        onClick={async () => {
          const src = await open({ filters: [{ name: "Vapor save", extensions: ["vsave"] }] });
          if (typeof src === "string") {
            await run("Importando", () => api.importSave(src));
            reload();
          }
        }}
      >
        Importar .vsave
      </button>
      <button
        onClick={async () => {
          await run("Apagando saves", () => api.deleteGameSaves(game.slug));
          reload();
        }}
      >
        Apagar todos os saves
      </button>
    </aside>
  );
}
