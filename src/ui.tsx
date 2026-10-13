import { ReactNode, useEffect, useState } from "react";

/** One thing the catalog can show: a game Vapor runs in the browser engine, or a native port. */
export interface Item {
  key: string;
  title: string;
  subtitle: string;
  cover?: string;
  tags: string[];
  kind: "wasm" | "native";
  badge?: { text: string; tone: "ok" | "warn" | "muted" };
  /** Cannot be played on this computer: the card is dimmed. */
  unavailable?: boolean;
}

const ICONS = {
  home: "M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10M10 19.5v-5h4v5",
  explore: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15.5 8.5l-2 5-5 2 2-5z",
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  library: "M6 4h12v17l-6-4-6 4z",
  download: "M12 4v11M7.5 11 12 15.5 16.5 11M5 20h14",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM9 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  search: "M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM16 16l4.5 4.5",
  play: "M8 5l11 7-11 7z",
  left: "M15 5l-7 7 7 7",
  right: "M9 5l7 7-7 7",
  flame: "M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 2.5 1.5 2.5C10 9 10.5 5.5 12 3z",
  trophy: "M8 4h8v5a4 4 0 0 1-8 0zM8 6H5v1a3 3 0 0 0 3 3M16 6h3v1a3 3 0 0 1-3 3M12 13v4M8.5 20h7M10 17h4",
  level: "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z",
  refresh: "M20 12a8 8 0 1 1-2.5-5.8M20 4v4h-4",
  close: "M6 6l12 12M18 6 6 18",
} as const;

export type IconName = keyof typeof ICONS;

/** One icon set (Lucide-style: 24px grid, round 1.8px stroke) so every icon matches. */
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

export function IconButton(props: { icon: IconName; label: string; onClick: () => void; size?: 32 | 36 | 40; disabled?: boolean }) {
  return (
    <button
      className={`icon-btn s${props.size ?? 40}`}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
    </button>
  );
}

/** Store-style cover: the official image when the catalog has one, a titled placeholder otherwise. */
export function Cover({ src, title, className = "" }: { src?: string; title: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (src && !broken) {
    return (
      <img
        className={`cover ${className}`}
        src={src}
        alt={`Cover of ${title}`}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <div className={`cover placeholder ${className}`} role="img" aria-label={`No cover for ${title}`}>
      {title.slice(0, 2).toUpperCase()}
    </div>
  );
}

export function Chips({ tags, max = 2 }: { tags: string[]; max?: number }) {
  return (
    <div className="chips">
      {tags.slice(0, max).map((t) => (
        <span key={t} className="chip">{t}</span>
      ))}
    </div>
  );
}

export function GameCard({ item, onOpen }: { item: Item; onOpen: () => void }) {
  return (
    <button className={`card${item.unavailable ? " unavailable" : ""}`} onClick={onOpen}>
      <Cover src={item.cover} title={item.title} />
      <span className="card-body">
        <strong className="card-title">{item.title}</strong>
        <span className="card-meta">
          {item.badge && <span className={`badge ${item.badge.tone}`}>{item.badge.text}</span>}
          <Chips tags={item.tags.length ? item.tags : [item.kind === "wasm" ? "WebAssembly" : "Native"]} />
        </span>
      </span>
    </button>
  );
}

export function SectionHeader(props: { title: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="section-head">
      <h2>{props.title}</h2>
      {props.action && (
        <button className="link" onClick={props.action.onClick}>
          {props.action.label} <Icon name="right" size={14} />
        </button>
      )}
    </div>
  );
}

export function GameGrid({ items, open }: { items: Item[]; open: (i: Item) => void }) {
  return (
    <div className="game-grid">
      {items.map((i) => (
        <GameCard key={i.key} item={i} onOpen={() => open(i)} />
      ))}
    </div>
  );
}

export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="xp-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <div className="xp-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-close">
          <IconButton icon="close" label="Close" size={36} onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
}
