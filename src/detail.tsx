import { useCallback, useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, ByoStatus, Game, SaveMeta } from "./api";
import { Run } from "./native";
import { Chips, Cover, Icon } from "./ui";

/** A game Vapor runs itself: install, play, bring-your-own files and saves. */
export function GameDetail(props: { game: Game; installed: boolean; run: Run }) {
  const { game, installed, run } = props;
  const [saves, setSaves] = useState<SaveMeta[]>([]);
  const [byo, setByo] = useState<ByoStatus[]>([]);
  const isByo = game.assets_policy === "bring-your-own";

  const reloadByo = useCallback(() => {
    if (!isByo || !installed) return setByo([]);
    api.byoStatus(game.slug).then(setByo).catch(() => setByo([]));
  }, [game.slug, isByo, installed]);
  useEffect(reloadByo, [reloadByo]);
  const ready = byo.every((f) => f.present);

  const reload = useCallback(() => {
    api.listSaves(game.slug).then(setSaves).catch(() => setSaves([]));
  }, [game.slug]);
  useEffect(reload, [reload]);

  return (
    <div className="detail">
      <Cover src={game.cover} title={game.title} className="detail-cover" />
      <div className="detail-body">
        <h2>{game.title}</h2>
        <p className="muted">{game.authors.join(", ")}</p>
        <Chips tags={game.tags} max={5} />
        <p>
          License: {game.license.code} · Assets: {isByo ? "bring your own (BYO)" : "open"}
        </p>
        <p>
          <a
            href={game.source.repo}
            onClick={(e) => { e.preventDefault(); openUrl(game.source.repo); }}
          >
            Source code
          </a>{" "}
          · contact: {game.contact}
        </p>

        <div className="row">
          {installed ? (
            <>
              <button
                className="btn primary"
                disabled={isByo && !ready}
                onClick={() => run("Starting", () => api.playGame(game.slug), { type: "play", slug: game.slug })}
              >
                <Icon name="play" /> Play now
              </button>
              <button className="btn" onClick={() => run("Uninstalling", () => api.uninstallGame(game.slug))}>
                Uninstall
              </button>
            </>
          ) : (
            <button className="btn primary" onClick={() => run("Downloading and verifying", () => api.installGame(game.slug), { type: "install", slug: game.slug })}>
              Install
            </button>
          )}
        </div>

        {installed && isByo && (
          <div className="panel">
            <h3>Your game files</h3>
            <p>
              This game does not include its assets. Pick files you own; they are checked on this computer and
              never uploaded.
            </p>
            <ul className="plain">
              {byo.map((f) => (
                <li key={f.name} className="row spread">
                  <span>{f.description} {f.present ? "✓" : "(missing)"}</span>
                  <button
                    className="btn"
                    onClick={async () => {
                      const src = await open();
                      if (typeof src === "string") {
                        await run("Verifying file", () => api.byoImport(game.slug, f.name, src), { type: "byo" });
                        reloadByo();
                      }
                    }}
                  >
                    {f.present ? "Replace" : "Choose file"}
                  </button>
                </li>
              ))}
            </ul>
            <button
              className="btn"
              onClick={async () => {
                await run("Removing your files", () => api.byoClear(game.slug));
                reloadByo();
              }}
            >
              Remove my files
            </button>
          </div>
        )}

        <div className="panel">
          <h3>Saves</h3>
          <ul className="plain">
            {saves.map((s) => (
              <li key={s.slot} className="row spread">
                <span>{s.slot} · rev {s.revision} · {new Date(s.created_at * 1000).toLocaleString()}</span>
                <button
                  className="btn"
                  onClick={async () => {
                    const dest = await save({ defaultPath: `${s.slug}-${s.slot}.vsave` });
                    if (dest) await run("Exporting", () => api.exportSave(s.slug, s.slot, dest));
                  }}
                >
                  Export
                </button>
              </li>
            ))}
            {saves.length === 0 && <li className="muted">No saves.</li>}
          </ul>
          <div className="row">
            <button
              className="btn"
              onClick={async () => {
                const src = await open({ filters: [{ name: "Vapor save", extensions: ["vsave"] }] });
                if (typeof src === "string") {
                  await run("Importing", () => api.importSave(src), { type: "save" });
                  reload();
                }
              }}
            >
              Import .vsave
            </button>
            <button
              className="btn danger"
              onClick={async () => {
                await run("Deleting saves", () => api.deleteGameSaves(game.slug));
                reload();
              }}
            >
              Delete all saves
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
