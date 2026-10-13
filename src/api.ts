import { invoke } from "@tauri-apps/api/core";

export interface Game {
  slug: string;
  /** Cover image URL (official art found through a public API, or ours). */
  cover?: string;
  title: string;
  authors: string[];
  source: { repo: string; commit: string };
  license: { code: string; assets: string };
  assets_policy: "open" | "bring-your-own";
  byo_files?: { name: string; description: string; sha256: string; size: number; mount: string }[];
  artifact: { url: string; sha256: string; size: number; entry: string };
  saves: { paths: string[]; version: number };
  tags: string[];
  contact: string;
}

export interface LinkStatus {
  state: "alive" | "stale" | "archived" | "unknown" | "gone" | "blocked";
  checked_at: string;
  pushed_at?: string | null;
  latest_release?: string | null;
}

export interface NativeBuild {
  platform: "windows" | "linux";
  url: string;
  sha256: string;
  size: number;
  exe: string;
  reviewed_by: string;
  reviewed_on: string;
  /** reviewed = a named person looked at it; scanned = only hash pinned + antivirus scan. */
  trust: "reviewed" | "scanned";
  notes?: string;
}

export interface SystemInfo {
  os: string;
  arch: string;
  /** Windows or Linux on x86-64: pinned native builds can run here. */
  native_ok: boolean;
}

export interface ExternalEntry {
  slug: string;
  cover?: string;
  title: string;
  publisher: string;
  url: string;
  platforms: string[];
  requires: string;
  summary: string;
  legal_note: string;
  tags: string[];
  group?: string;
  variant?: string;
  native?: NativeBuild[];
  status?: LinkStatus;
}

export interface SaveMeta {
  slug: string;
  slot: string;
  save_version: number;
  artifact_sha256: string;
  revision: number;
  created_at: number;
}

export interface ByoStatus {
  name: string;
  description: string;
  size: number;
  present: boolean;
}

export interface RefreshResult {
  total: number;
  removed: string[];
  rejected: string[];
}

export const api = {
  runNative: (slug: string, confirm: string) => invoke<number>("run_native", { slug, confirm }),
  getSystem: () => invoke<SystemInfo>("get_system"),
  getLinks: () => invoke<ExternalEntry[]>("get_links"),
  getCatalog: (query?: string) => invoke<Game[]>("get_catalog", { query }),
  refreshCatalog: () => invoke<RefreshResult>("refresh_catalog"),
  installGame: (slug: string) => invoke<void>("install_game", { slug }),
  playGame: (slug: string) => invoke<void>("play_game", { slug }),
  byoStatus: (slug: string) => invoke<ByoStatus[]>("byo_status", { slug }),
  byoImport: (slug: string, name: string, src: string) =>
    invoke<void>("byo_import", { slug, name, src }),
  byoClear: (slug: string) => invoke<void>("byo_clear", { slug }),
  uninstallGame: (slug: string) => invoke<void>("uninstall_game", { slug }),
  installedGames: () => invoke<string[]>("installed_games"),
  listSaves: (slug: string) => invoke<SaveMeta[]>("list_saves", { slug }),
  exportSave: (slug: string, slot: string, dest: string) =>
    invoke<void>("export_save", { slug, slot, dest }),
  importSave: (src: string) => invoke<SaveMeta>("import_save", { src }),
  deleteGameSaves: (slug: string) => invoke<void>("delete_game_saves", { slug }),
};
