import { invoke } from "@tauri-apps/api/core";

export interface Game {
  slug: string;
  title: string;
  authors: string[];
  source: { repo: string; commit: string };
  license: { code: string; assets: string };
  assets_policy: "open" | "bring-your-own";
  artifact: { url: string; sha256: string; size: number; entry: string };
  saves: { paths: string[]; version: number };
  tags: string[];
  contact: string;
}

export interface SaveMeta {
  slug: string;
  slot: string;
  save_version: number;
  artifact_sha256: string;
  revision: number;
  created_at: number;
}

export interface RefreshResult {
  total: number;
  removed: string[];
}

export const api = {
  getCatalog: (query?: string) => invoke<Game[]>("get_catalog", { query }),
  refreshCatalog: () => invoke<RefreshResult>("refresh_catalog"),
  installGame: (slug: string) => invoke<void>("install_game", { slug }),
  playGame: (slug: string) => invoke<void>("play_game", { slug }),
  uninstallGame: (slug: string) => invoke<void>("uninstall_game", { slug }),
  installedGames: () => invoke<string[]>("installed_games"),
  listSaves: (slug: string) => invoke<SaveMeta[]>("list_saves", { slug }),
  exportSave: (slug: string, slot: string, dest: string) =>
    invoke<void>("export_save", { slug, slot, dest }),
  importSave: (src: string) => invoke<SaveMeta>("import_save", { src }),
  deleteGameSaves: (slug: string) => invoke<void>("delete_game_saves", { slug }),
};
