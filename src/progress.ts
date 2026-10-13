// Player progress shown in the gamification bar. Everything here is derived from things the player
// really did in this app (installing, playing, importing); nothing is invented or sent anywhere.
// It lives in this webview's localStorage, so it is per computer and the player can clear it.

export interface Progress {
  xp: number;
  /** Days (YYYY-MM-DD, local time) on which a game was started. */
  days: string[];
  installed: string[];
  played: string[];
  /** One-off milestones: "native", "save", "byo". */
  flags: string[];
}

export type ProgressEvent =
  | { type: "install"; slug: string }
  | { type: "play"; slug: string }
  | { type: "native"; slug: string }
  | { type: "save" }
  | { type: "byo" };

export const EMPTY: Progress = { xp: 0, days: [], installed: [], played: [], flags: [] };

export const XP = { install: 50, play: 10, firstPlay: 90, native: 100, save: 25, byo: 25 } as const;

/** XP needed to finish level `level` (level 1 needs 500, each next one 250 more). */
export function xpNeeded(level: number): number {
  return 500 + 250 * (level - 1);
}

export function levelOf(xp: number): { level: number; into: number; need: number } {
  let level = 1;
  let left = Math.max(0, xp);
  while (left >= xpNeeded(level)) {
    left -= xpNeeded(level);
    level += 1;
  }
  return { level, into: left, need: xpNeeded(level) };
}

/** `YYYY-MM-DD` of a date in local time. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Consecutive days with a game started, counting back from today (or yesterday if today has none yet). */
export function streak(days: string[], today: Date): number {
  const set = new Set(days);
  let cursor = set.has(dayKey(today)) ? today : addDays(today, -1);
  let n = 0;
  while (set.has(dayKey(cursor))) {
    n += 1;
    cursor = addDays(cursor, -1);
  }
  return n;
}

const add = (list: string[], v: string) => (list.includes(v) ? list : [...list, v]);

export function apply(p: Progress, ev: ProgressEvent, today: Date): Progress {
  const next = { ...p };
  switch (ev.type) {
    case "install":
      if (!p.installed.includes(ev.slug)) {
        next.installed = add(p.installed, ev.slug);
        next.xp += XP.install;
      }
      break;
    case "play":
    case "native": {
      next.xp += XP.play;
      if (!p.played.includes(ev.slug)) {
        next.played = add(p.played, ev.slug);
        next.xp += ev.type === "native" ? XP.native - XP.play : XP.firstPlay;
      }
      if (ev.type === "native") next.flags = add(p.flags, "native");
      next.days = add(p.days, dayKey(today));
      break;
    }
    case "save":
      if (!p.flags.includes("save")) {
        next.flags = add(p.flags, "save");
        next.xp += XP.save;
      }
      break;
    case "byo":
      if (!p.flags.includes("byo")) {
        next.flags = add(p.flags, "byo");
        next.xp += XP.byo;
      }
      break;
  }
  return next;
}

export interface Achievement {
  id: string;
  title: string;
  hint: string;
  done: (p: Progress, today: Date) => boolean;
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: "first-install", title: "First install", hint: "Install a game", done: (p) => p.installed.length >= 1 },
  { id: "first-play", title: "Player one", hint: "Start a game", done: (p) => p.played.length >= 1 },
  { id: "two-games", title: "Small library", hint: "Install two games", done: (p) => p.installed.length >= 2 },
  { id: "native", title: "Going native", hint: "Run a native port", done: (p) => p.flags.includes("native") },
  { id: "own-files", title: "Bring your own", hint: "Import your own game files", done: (p) => p.flags.includes("byo") },
  { id: "save", title: "Safe keeping", hint: "Import a save", done: (p) => p.flags.includes("save") },
  { id: "streak-3", title: "Three in a row", hint: "Play 3 days in a row", done: (p, t) => streak(p.days, t) >= 3 },
  { id: "streak-7", title: "A whole week", hint: "Play 7 days in a row", done: (p, t) => streak(p.days, t) >= 7 },
];

const KEY = "vapor.progress.v1";

export function load(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const v = JSON.parse(raw);
    const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s) => typeof s === "string").slice(0, 500) : []);
    return {
      xp: typeof v.xp === "number" && v.xp >= 0 && Number.isFinite(v.xp) ? Math.floor(v.xp) : 0,
      days: strings(v.days),
      installed: strings(v.installed),
      played: strings(v.played),
      flags: strings(v.flags),
    };
  } catch {
    return EMPTY;
  }
}

export function store(p: Progress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Private mode or blocked storage: progress just is not remembered.
  }
}
