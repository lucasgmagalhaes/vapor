// A repository is only a candidate when its README (or GitHub homepage) points to a
// live product page on a recognized game storefront. The link is evidence of the
// underlying released game, not evidence that this port is licensed or playable.
const STORES = [
  { platform: "steam", host: "store.steampowered.com", path: /^\/app\/(\d+)(?:\/|$)/ },
  { platform: "epic", host: "store.epicgames.com", path: /^\/[a-z]{2}(?:-[a-z]{2})?\/p\/([a-z0-9-]+)(?:\/|$)/i },
  { platform: "playstation", host: "store.playstation.com", path: /^\/[a-z]{2}-[a-z]{2}\/product\/([A-Z0-9_-]+)(?:\/|$)/i },
  { platform: "playstation", host: "www.playstation.com", path: /^\/[a-z]{2}-[a-z]{2}\/games\/([a-z0-9-]+)(?:\/|$)/i },
  { platform: "xbox", host: "www.xbox.com", path: /^\/[a-z]{2}-[a-z]{2}\/games\/store\/([a-z0-9-]+)(?:\/|$)/i },
  { platform: "nintendo", host: "www.nintendo.com", path: /^\/[a-z]{2}-[a-z]{2}\/store\/products\/([a-z0-9-]+)(?:\/|$)/i },
];

const normalized = (s) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const matchesTitle = (title, text) => {
  const words = normalized(title).split(" ").filter((w) => w.length > 2 && !/^(game|edition|standard|digital|steam|epic)$/.test(w));
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

export async function verifyDistribution(text, fetcher = fetch) {
  const links = storeLinks(text).sort((a, b) => Number(b.platform === "steam") - Number(a.platform === "steam")).slice(0, 3);
  const projectText = text.replace(/https?:\/\/\S+/gi, " ");
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
  return { status: "unverified", reason: links.length ? "store listing could not be confirmed as a released game" : "no official Steam, Epic, PlayStation, Xbox, or Nintendo game listing linked" };
}
