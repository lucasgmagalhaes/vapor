import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, ExternalEntry, NativeBuild, SystemInfo } from "./api";
import { ProgressEvent } from "./progress";
import { Cover } from "./ui";

/** Runs an action with a status line; a successful `event` counts toward the player's progress. */
export type Run = (label: string, fn: () => Promise<unknown>, event?: ProgressEvent) => Promise<void>;

function mb(n: number) {
  return `${Math.round(n / 1048576)} MB`;
}

const OS_LABEL: Record<string, string> = { windows: "Windows", linux: "Linux", macos: "macOS" };
export const label = (os: string) => OS_LABEL[os] ?? os;

/** Entries of one game (same `group`) shown as one card. */
export function groupLinks(links: ExternalEntry[]): ExternalEntry[][] {
  const groups = new Map<string, ExternalEntry[]>();
  for (const l of links) groups.set(l.group ?? l.slug, [...(groups.get(l.group ?? l.slug) ?? []), l]);
  return [...groups.values()];
}

/** What this computer can do with a game: the variant for its system and a plain verdict. */
export function availability(entries: ExternalEntry[], system: SystemInfo) {
  const variant = entries.find((e) => e.platforms.includes(system.os));
  const build = variant?.native?.find((n) => n.platform === system.os);
  const all = [...new Set(entries.flatMap((e) => e.platforms))];
  if (!variant) return { kind: "unavailable" as const, variant, build, all };
  if (!system.native_ok) return { kind: "cannot-run" as const, variant, build, all };
  if (!build) return { kind: "no-build" as const, variant, build, all };
  return { kind: "ready" as const, variant, build, all };
}

/** Short verdict shown on cards. */
export function verdict(kind: ReturnType<typeof availability>["kind"], system: SystemInfo) {
  switch (kind) {
    case "ready":
      return { text: `Ready for ${label(system.os)}`, tone: "ok" as const };
    case "no-build":
      return { text: "No verified build yet", tone: "warn" as const };
    case "cannot-run":
      return { text: `Cannot run on ${system.arch}`, tone: "warn" as const };
    default:
      return { text: `Not for ${label(system.os)}`, tone: "muted" as const };
  }
}

/** Native programs: how the build is vouched for, the risk, and a typed confirmation. */
function NativeRun(props: { entry: ExternalEntry; build: NativeBuild; run: Run }) {
  const { entry, build, run } = props;
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const reviewed = build.trust === "reviewed";
  return (
    <div className="panel native">
      <p>
        <strong>{reviewed ? "Reviewed build" : "Automatically scanned build (not reviewed by a person)"}</strong>
        {" "}pinned by {build.reviewed_by} on {build.reviewed_on} · {mb(build.size)} · sha256{" "}
        <code>{build.sha256.slice(0, 12)}…</code>
      </p>
      {build.notes && <p>{build.notes}</p>}
      {!open ? (
        <button className="btn primary" onClick={() => setOpen(true)}>Download and run…</button>
      ) : (
        <div className="confirm">
          <p>
            This downloads a <strong>native program</strong> from the project's own release, checks its size and
            SHA-256 against the pinned values, and runs it with <strong>your user's permissions</strong>. Vapor
            cannot sandbox it, and the checks do not prove it is safe
            {reviewed ? "" : "; nobody has reviewed it, it was only hash-pinned and antivirus-scanned"}. The
            files are re-checked before every launch.
          </p>
          <p>
            Type <code>{entry.slug}</code> to confirm:
          </p>
          <input className="field" value={typed} onChange={(e) => setTyped(e.target.value)} />
          <div className="row">
            <button
              className="btn primary"
              disabled={typed !== entry.slug}
              onClick={() => run("Downloading, verifying and starting", () => api.runNative(entry.slug, typed), { type: "native", slug: entry.slug })}
            >
              Run
            </button>
            <button className="btn" onClick={() => { setOpen(false); setTyped(""); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Everything about one native game: the version for this system, what it needs and how to run it. */
export function NativeDetail(props: { entries: ExternalEntry[]; system: SystemInfo; run: Run }) {
  const { entries, system, run } = props;
  const a = availability(entries, system);
  const shown = a.variant ?? entries[0];
  const v = verdict(a.kind, system);
  return (
    <div className="detail">
      <Cover src={shown.cover} title={shown.title} className="detail-cover" />
      <div className="detail-body">
        <h2>{shown.title}</h2>
        <p className="muted">{shown.publisher}</p>
        <span className={`badge ${v.tone}`}>{v.text}</span>
        <p>
          {a.kind === "unavailable" ? `Exists only for: ${a.all.map(label).join(", ")}.` : shown.summary}
        </p>
        {a.kind !== "unavailable" && (
          <>
            {shown.variant && <p><em>Version:</em> {shown.variant}</p>}
            <p><em>Needs:</em> {shown.requires}</p>
            {/dump|disc image/i.test(shown.requires) && (
              <details className="panel dump-help">
                <summary>What is a game dump?</summary>
                <p>
                  This port is only the game engine, rewritten to run on a PC. It does not include the game
                  itself: the models, textures, sound and levels. Those come from your own copy, which you copy
                  (dump) from the disc or console you bought. Vapor never downloads, hosts or uploads game
                  files, and your dump stays on this computer.
                </p>
                <p>The exact files needed are listed above. Without them the port cannot start.</p>
              </details>
            )}
            <p className="legal">{shown.legal_note}</p>
            {shown.status && (
              <p className="muted">
                Source {shown.status.state}
                {shown.status.latest_release ? ` · latest release ${shown.status.latest_release}` : ""}
              </p>
            )}
            {a.kind === "ready" && a.build && <NativeRun entry={shown} build={a.build} run={run} />}
            {a.kind === "cannot-run" && (
              <p>Pinned builds are x86-64 programs and Vapor does not emulate; this computer is {system.arch}.</p>
            )}
            <div className="row">
              <button className="btn" onClick={() => openUrl(shown.url)}>Open original source</button>
            </div>
          </>
        )}
        <p className="muted credit">Cover served by its source and owned by its rights holder.</p>
      </div>
    </div>
  );
}
