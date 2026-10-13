// Store pages and reviewed publisher release coverage establish that the underlying
// game was distributed. Neither establishes that a port is licensed or playable.
const STORES = [
  { platform: "steam", host: "store.steampowered.com", path: /^\/app\/(\d+)(?:\/|$)/ },
  { platform: "epic", host: "store.epicgames.com", path: /^\/[a-z]{2}(?:-[a-z]{2})?\/p\/([a-z0-9-]+)(?:\/|$)/i },
  { platform: "playstation", host: "store.playstation.com", path: /^\/[a-z]{2}-[a-z]{2}\/product\/([A-Z0-9_-]+)(?:\/|$)/i },
  { platform: "playstation", host: "www.playstation.com", path: /^\/[a-z]{2}-[a-z]{2}\/games\/([a-z0-9-]+)(?:\/|$)/i },
  { platform: "xbox", host: "www.xbox.com", path: /^\/[a-z]{2}-[a-z]{2}\/games\/store\/([a-z0-9-]+)(?:\/|$)/i },
  { platform: "nintendo", host: "www.nintendo.com", path: /^\/[a-z]{2}-[a-z]{2}\/store\/products\/([a-z0-9-]+)(?:\/|$)/i },
];

const normalized = (s) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
export const matchesTitle = (title, text) => {
  const words = normalized(title).split(" ").filter((w) => (w.length > 2 || /^\d+$/.test(w)) && !/^(game|edition|standard|digital|steam|epic)$/.test(w));
  const haystack = ` ${normalized(text)} `;
  return words.length > 0 && words.join("").length >= 4 && words.every((w) => haystack.includes(` ${w} `));
};

export function storeLinks(text) {
  const urls = text.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];
  return [...new Map(urls.flatMap((raw) => {
    try {
      const url = new URL(raw.replace(/[.,;]+$/, ""));
      const store = STORES.find((s) => url.hostname.toLowerCase() === s.host && s.path.test(url.pathname));
      if (!store || url.protocol !== "https:") return [];
      url.search = "";
      url.hash = "";
      return [[url.href, { platform: store.platform, url: url.href, slug: store.path.exec(url.pathname)[1] }]];
    } catch { return []; }
  })).values()];
}

export async function verifyDistribution(text, fetcher = fetch, reviewed = null) {
  const links = storeLinks(text).sort((a, b) => Number(b.platform === "steam") - Number(a.platform === "steam")).slice(0, 3);
  const projectText = text.replace(/https?:\/\/\S+/gi, " ");
  if (reviewed) {
    try {
      const source = new URL(reviewed.url);
      const official = ["www.halowaypoint.com", "news.xbox.com"].includes(source.hostname);
      const released = /^\d{4}-\d{2}-\d{2}$/.test(reviewed.released_at) && Date.parse(reviewed.released_at) <= Date.now();
      const exactTitle = ` ${normalized(projectText)} `.includes(` ${normalized(reviewed.title)} `);
      if (source.protocol === "https:" && official && released && exactTitle && reviewed.platform === "xbox") {
        return { status: "verified", platform: reviewed.platform, url: source.href, title: reviewed.title, released_at: reviewed.released_at, source: "reviewed-publisher-release" };
      }
    } catch { /* Invalid reviewed evidence cannot bypass verification. */ }
  }
  for (const link of links) {
    try {
      if (link.platform === "steam") {
        const res = await fetcher(`https://store.steampowered.com/api/appdetails?appids=${link.slug}&filters=basic,release_date`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) continue;
        const app = (await res.json())?.[link.slug];
        if (app?.success && app.data?.type === "game" && app.data?.release_date?.coming_soon === false && matchesTitle(app.data.name, projectText)) {
          return { status: "verified", platform: "steam", url: link.url, title: app.data.name };
        }
        continue;
      }
      const res = await fetcher(link.url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok || !storeLinks(res.url ?? link.url).some((s) => s.platform === link.platform)) continue;
      const html = (await res.text()).slice(0, 500_000);
      const title = /<meta\s+[^>]*property=["']og:title["'][^>]*content=["']([^"']+)/i.exec(html)?.[1]
        ?? /<title[^>]*>([^<]+)/i.exec(html)?.[1];
      if (title && matchesTitle(title.replace(/\s*[|–-].*$/, ""), projectText)) {
        return { status: "review", platform: link.platform, url: link.url, title, reason: "official product page found; release and project identity need human confirmation" };
      }
    } catch { /* Store outages leave the candidate unverified. */ }
  }
  return { status: "unverified", reason: links.length ? "linked store listing could not be confirmed as a released game" : "repository has no supported store link or reviewed publisher release evidence" };
}
