import { useState } from "react";
import { ACHIEVEMENTS, Progress, XP, levelOf, streak } from "./progress";
import { Icon, IconButton, IconName, Modal, ProgressBar } from "./ui";

export const BRAND = "Wastem";

export type View = "home" | "explore" | "categories" | "collection" | "downloads" | "settings";

const NAV: { view: View; label: string; icon: IconName }[] = [
  { view: "home", label: "Home", icon: "home" },
  { view: "explore", label: "Explore", icon: "explore" },
  { view: "categories", label: "Categories", icon: "grid" },
  { view: "collection", label: "Collection", icon: "library" },
];

const SIDE: { view: View; label: string; icon: IconName }[] = [
  ...NAV,
  { view: "downloads", label: "Downloads", icon: "download" },
  { view: "settings", label: "Settings", icon: "settings" },
];

const fmt = (n: number) => n.toLocaleString("en-US");

/** Always on top. Every number comes from what the player really did (see progress.ts). */
export function GamificationBar(props: { progress: Progress; onRefresh: () => void }) {
  const { progress } = props;
  const [panel, setPanel] = useState<"level" | "achievements" | null>(null);
  const today = new Date();
  const lv = levelOf(progress.xp);
  const days = streak(progress.days, today);
  const unlocked = ACHIEVEMENTS.filter((a) => a.done(progress, today));

  return (
    <div className="gami" role="region" aria-label="Your progress">
      <button className="gami-group gami-level" title="Level details" onClick={() => setPanel("level")}>
        <span className="gami-icon level"><Icon name="level" size={22} /></span>
        <span className="gami-strong">Lv. {lv.level}</span>
        <span className="gami-xp"><ProgressBar value={lv.into} max={lv.need} label="Experience in this level" /></span>
        <span className="gami-muted">{fmt(lv.into)} / {fmt(lv.need)} XP</span>
      </button>

      <div className="gami-center">
        <span className="gami-group" title="Days in a row with a game started">
          <span className="gami-icon streak"><Icon name="flame" size={20} /></span>
          <span className="gami-strong">{days} {days === 1 ? "day" : "days"}</span>
        </span>
        <span className="gami-sep" aria-hidden="true" />
        <button className="gami-group" title="Achievements" onClick={() => setPanel("achievements")}>
          <span className="gami-icon trophy"><Icon name="trophy" size={20} /></span>
          <span className="gami-strong">{unlocked.length}/{ACHIEVEMENTS.length}</span>
        </button>
      </div>

      <div className="gami-right">
        <IconButton icon="refresh" label="Refresh catalog" onClick={props.onRefresh} />
      </div>

      {panel === "level" && (
        <Modal onClose={() => setPanel(null)}>
          <div className="modal-pad">
            <h2>Level {lv.level}</h2>
            <p className="muted">{fmt(lv.need - lv.into)} XP to level {lv.level + 1}. Total: {fmt(progress.xp)} XP.</p>
            <h3>How you earn XP</h3>
            <ul className="plain">
              <li>Install a game: {XP.install} XP (once per game)</li>
              <li>Start a game: {XP.play} XP, and {XP.firstPlay} more the first time</li>
              <li>Run a native port for the first time: {XP.native} XP</li>
              <li>Import a save: {XP.save} XP (once)</li>
              <li>Import your own game files: {XP.byo} XP (once)</li>
            </ul>
            <p className="muted">Progress is kept on this computer only.</p>
          </div>
        </Modal>
      )}
      {panel === "achievements" && (
        <Modal onClose={() => setPanel(null)}>
          <div className="modal-pad">
            <h2>Achievements {unlocked.length}/{ACHIEVEMENTS.length}</h2>
            <ul className="plain achievements">
              {ACHIEVEMENTS.map((a) => {
                const done = a.done(progress, today);
                return (
                  <li key={a.id} className={done ? "done" : ""}>
                    <span className="gami-icon trophy"><Icon name="trophy" size={18} /></span>
                    <span>
                      <strong>{a.title}</strong>
                      <span className="muted"> · {a.hint}</span>
                    </span>
                    <span className="badge-state">{done ? "Unlocked" : "Locked"}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function NavigationHeader(props: { view: View; setView: (v: View) => void; query: string; setQuery: (q: string) => void }) {
  return (
    <header className="topnav">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true"><Icon name="play" size={18} /></span>
        <span className="brand-name">{BRAND}</span>
      </div>
      <nav className="topnav-links" aria-label="Main">
        {NAV.map((n) => (
          <button
            key={n.view}
            className={`toplink${props.view === n.view ? " active" : ""}`}
            aria-current={props.view === n.view ? "page" : undefined}
            onClick={() => props.setView(n.view)}
          >
            {n.label}
          </button>
        ))}
      </nav>
      <label className="search">
        <Icon name="search" size={18} />
        <input
          type="search"
          placeholder="Search games, genres, studios…"
          aria-label="Search games"
          value={props.query}
          onChange={(e) => {
            props.setQuery(e.target.value);
            if (props.view === "home") props.setView("explore");
          }}
        />
      </label>
    </header>
  );
}

export function Sidebar(props: { view: View; setView: (v: View) => void }) {
  return (
    <aside className="sidebar">
      <nav aria-label="Sections">
        {SIDE.map((n) => (
          <button
            key={n.view}
            className={`side-item${props.view === n.view ? " active" : ""}`}
            aria-current={props.view === n.view ? "page" : undefined}
            onClick={() => props.setView(n.view)}
          >
            <Icon name={n.icon} />
            <span>{n.label}</span>
          </button>
        ))}
      </nav>
      <div className="side-note">
        <strong>Runs in your browser engine</strong>
        <span>WebAssembly games need no setup. Native ports run as normal programs and say so.</span>
      </div>
    </aside>
  );
}
