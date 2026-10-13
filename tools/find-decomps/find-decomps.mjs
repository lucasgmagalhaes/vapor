#!/usr/bin/env node
// Busca no GitHub projetos de decompilação de jogos que sirvam de base para portar a wasm.
// Uso: node tools/find-decomps/find-decomps.mjs [opções]
//   --query "resident evil"   termo livre (opcional; sem ele lista por tópicos)
//   --min-stars 20            mínimo de estrelas (padrão 10)
//   --limit 30                máximo de resultados (padrão 30)
//   --deep                    inspeciona a árvore de arquivos atrás de sinais de wasm/emscripten/SDL
//   --json                    saída em JSON (padrão: tabela)
// Defina GITHUB_TOKEN para evitar o rate limit baixo da API anônima.
// Este script só DESCOBRE candidatos. Licença e direitos dos assets exigem revisão humana.

const API = "https://api.github.com";
const TOPICS = ["decompilation", "matching-decompilation", "game-decompilation", "decomp"];
const WASM_HINTS = [/emscripten/i, /\bwasm\b/i, /webassembly/i, /\bemcc\b/i, /\bsdl2?\b/i, /\bopengl\b/i];
const BYO_HINTS = [/bring your own/i, /own (copy|rom|disc)/i, /requires? (a )?(rom|iso|assets)/i, /assets? (are )?not (included|provided)/i];

function parseArgs(argv) {
  const o = { query: "", minStars: 10, limit: 30, deep: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--query") o.query = argv[++i] ?? "";
    else if (a === "--min-stars") o.minStars = Number(argv[++i]);
    else if (a === "--limit") o.limit = Number(argv[++i]);
    else if (a === "--deep") o.deep = true;
    else if (a === "--json") o.json = true;
    else if (a === "-h" || a === "--help") { console.log("veja o cabeçalho do arquivo"); process.exit(0); }
    else { console.error(`opção desconhecida: ${a}`); process.exit(2); }
  }
  if (!Number.isFinite(o.minStars) || !Number.isFinite(o.limit)) { console.error("valores numéricos inválidos"); process.exit(2); }
  return o;
}

let useToken = Boolean(process.env.GITHUB_TOKEN);
const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "vapor-find-decomps",
};
const authHeaders = () => (useToken ? { ...headers, Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : headers);

async function gh(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API}${path}`, { headers: authHeaders() });
    if (res.status === 401 && useToken) {
      console.error("aviso: GITHUB_TOKEN rejeitado (401); seguindo sem autenticação (limite de requisições menor)");
      useToken = false;
      continue;
    }
    if (res.ok) return res.json();
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0" && reset) {
      const wait = Math.max(0, reset * 1000 - Date.now()) + 1000;
      if (wait > 90_000) throw new Error(`rate limit da API; tente após ${new Date(reset * 1000).toISOString()} ou defina GITHUB_TOKEN`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (res.status === 409 || res.status === 404) return null; // repo vazio / sem árvore
    throw new Error(`GitHub ${res.status} em ${path}: ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error(`falhou após tentativas: ${path}`);
}

async function search(opts) {
  const seen = new Map();
  const base = `stars:>=${opts.minStars} archived:false fork:false`;
  const queries = opts.query
    ? [`${opts.query} decompilation ${base}`, ...TOPICS.map((t) => `${opts.query} topic:${t} ${base}`)]
    : TOPICS.map((t) => `topic:${t} ${base}`);
  for (const q of queries) {
    for (let page = 1; page <= 3 && seen.size < opts.limit * 3; page++) {
      const r = await gh(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=50&page=${page}`);
      if (!r?.items?.length) break;
      for (const it of r.items) seen.set(it.full_name, it);
      if (r.items.length < 50) break;
    }
  }
  return [...seen.values()];
}

function score(repo, signals) {
  let s = Math.log10(repo.stargazers_count + 1) * 10;
  if (repo.license) s += 8;
  if (signals.wasm.length) s += 25;
  if (signals.byo) s += 10;
  if (/c\+\+|^c$|rust/i.test(repo.language ?? "")) s += 5;
  const months = (Date.now() - Date.parse(repo.pushed_at)) / 2.6e9;
  s -= Math.min(months * 2, 20); // projetos parados perdem pontos
  return Math.round(s);
}

async function inspect(repo, deep) {
  const text = [repo.name, repo.description ?? "", ...(repo.topics ?? [])].join(" ");
  const wasm = WASM_HINTS.filter((r) => r.test(text)).map((r) => r.source);
  let byo = BYO_HINTS.some((r) => r.test(text));
  if (deep) {
    const tree = await gh(`/repos/${repo.full_name}/git/trees/${repo.default_branch}?recursive=1`);
    const paths = (tree?.tree ?? []).map((n) => n.path.toLowerCase());
    if (paths.some((p) => /emscripten|\.wasm$|wasm/.test(p))) wasm.push("arquivos wasm/emscripten");
    if (paths.some((p) => /cmakelists\.txt$/.test(p))) wasm.push("cmake");
    const readme = await fetch(`https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/README.md`, { headers: { "User-Agent": headers["User-Agent"] } })
      .then((r) => (r.ok ? r.text() : "")).catch(() => "");
    if (BYO_HINTS.some((r) => r.test(readme))) byo = true;
    if (/emscripten|webassembly|\bwasm\b/i.test(readme)) wasm.push("README");
  }
  const signals = { wasm: [...new Set(wasm)], byo };
  return {
    repo: repo.full_name, url: repo.html_url, stars: repo.stargazers_count,
    license: repo.license?.spdx_id ?? null, language: repo.language,
    pushed_at: repo.pushed_at, description: repo.description, topics: repo.topics ?? [],
    signals, score: score(repo, signals),
  };
}

const opts = parseArgs(process.argv.slice(2));
const repos = await search(opts);
const results = [];
let deep = opts.deep;
for (const r of repos) {
  try {
    results.push(await inspect(r, deep));
  } catch (e) {
    if (!deep) throw e;
    console.error(`aviso: --deep desativado (${e.message}); usando só metadados`);
    deep = false;
    results.push(await inspect(r, false));
  }
}
results.sort((a, b) => b.score - a.score);
const top = results.slice(0, opts.limit);

if (opts.json) {
  console.log(JSON.stringify(top, null, 2));
} else {
  console.log(`${top.length} candidato(s) de ${results.length} encontrados${opts.deep ? "" : " (use --deep para sinais de wasm/BYO)"}\n`);
  for (const t of top) {
    const flags = [t.signals.wasm.length ? "wasm?" : "", t.signals.byo ? "BYO?" : "", t.license ? "" : "SEM-LICENÇA"].filter(Boolean).join(" ");
    console.log(`${String(t.score).padStart(3)}  ★${String(t.stars).padEnd(6)} ${t.repo.padEnd(45)} ${(t.license ?? "-").padEnd(12)} ${flags}`);
    if (t.description) console.log(`       ${t.description.slice(0, 110)}`);
  }
  console.log("\nAtenção: isto só lista candidatos. Revise licença e direitos dos assets antes de criar um manifesto.");
}
