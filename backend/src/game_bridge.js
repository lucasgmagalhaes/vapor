// Injected by Vapor into every game window (before any game script runs).
// Restores the saved files into the Emscripten virtual FS before the game starts and
// writes them back periodically and on close. It talks only to Vapor's own origin
// (`/<token>/__vapor/saves`); the game window has no Tauri IPC.
(() => {
  "use strict";
  const token = location.pathname.split("/")[1];
  if (!token) return;
  const API = "/" + token + "/__vapor/saves";
  const ROOTS = __VAPOR_SAVE_ROOTS__;
  // Files the player supplied for this game: [{ name, mount }].
  const BYO = __VAPOR_BYO__;
  const FLUSH_MS = 3000;
  let mod = null;
  let last = "";

  const toB64 = (u8) => {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(s);
  };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  function walk(FS, dir, out) {
    let names;
    try {
      names = FS.readdir(dir);
    } catch (_) {
      return;
    }
    for (const n of names) {
      if (n === "." || n === "..") continue;
      const p = (dir === "/" ? "" : dir) + "/" + n;
      const st = FS.stat(p);
      if (FS.isDir(st.mode)) walk(FS, p, out);
      else if (FS.isFile(st.mode)) out.push({ path: p, data: FS.readFile(p) });
    }
  }

  function collect(FS) {
    const out = [];
    for (const r of ROOTS) walk(FS, r.replace(/\/+$/, "") || "/", out);
    return out;
  }

  function signature(files) {
    let h = 0;
    for (const f of files) {
      h = (Math.imul(h, 31) + f.path.length) | 0;
      for (let i = 0; i < f.data.length; i++) h = (Math.imul(h, 31) + f.data[i]) | 0;
    }
    return files.length + ":" + h;
  }

  function flush(keepalive) {
    if (!mod || !mod.FS) return;
    try {
      const files = collect(mod.FS);
      const sig = signature(files);
      if (sig === last) return;
      const body = JSON.stringify({
        files: files.map((f) => ({ path: f.path, data: toB64(f.data) })),
      });
      fetch(API, { method: "PUT", body, keepalive: keepalive && body.length < 60000 })
        .then((r) => {
          if (r.ok) last = sig;
          else console.error("[vapor] save rejected", r.status);
        })
        .catch((e) => console.error("[vapor] save failed", e));
    } catch (e) {
      console.error("[vapor] save error", e);
    }
  }
  window.__vaporFlush = () => flush(true);

  function mountByo(m) {
    return Promise.all(
      BYO.map((f) =>
        fetch("/" + token + "/__vapor/byo/" + encodeURIComponent(f.name))
          .then((r) => {
            if (!r.ok) throw new Error(f.name + ": " + r.status);
            return r.arrayBuffer();
          })
          .then((buf) => {
            const dir = f.mount.slice(0, f.mount.lastIndexOf("/"));
            if (dir) m.FS.mkdirTree(dir);
            m.FS.writeFile(f.mount, new Uint8Array(buf));
          })
      )
    ).catch((e) => console.error("[vapor] could not mount player files", e));
  }

  function restore(m) {
    const dep = typeof m.addRunDependency === "function";
    if (dep) m.addRunDependency("vapor-saves");
    mountByo(m).then(() => fetch(API))
      .then((r) => (r.ok ? r.json() : { files: [] }))
      .then(({ files }) => {
        for (const f of files) {
          const dir = f.path.slice(0, f.path.lastIndexOf("/"));
          if (dir) m.FS.mkdirTree(dir);
          m.FS.writeFile(f.path, fromB64(f.data));
        }
        last = signature(collect(m.FS));
      })
      .catch((e) => console.error("[vapor] restore failed", e))
      .finally(() => {
        if (dep) m.removeRunDependency("vapor-saves");
      });
  }

  const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

  function hook(m) {
    if (!m || m.__vapor) return;
    m.__vapor = true;
    mod = m;
    m.preRun = [() => restore(m)].concat(asArray(m.preRun));
    m.postRun = asArray(m.postRun).concat([() => setInterval(() => flush(false), FLUSH_MS)]);
  }

  let current;
  Object.defineProperty(window, "Module", {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (v) => {
      current = v;
      hook(v);
    },
  });
  window.addEventListener("pagehide", () => flush(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush(true);
  });
})();
