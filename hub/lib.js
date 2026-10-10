// Shared bits for the API: read a data file from the (private) GitHub repo, cached 2 minutes at the edge,
// and trim it to the stores this user may see.
const REPO = "dhldustin-max/omc-weekly-live";

export async function repoFile(env, path, ctx) {
  const url = `https://api.github.com/repos/${REPO}/contents/${path}`;
  const cache = caches.default, key = new Request(url + "#v1");
  let res = await cache.match(key);
  if (!res) {
    const r = await fetch(url, { headers: { Accept: "application/vnd.github.raw+json", Authorization: `token ${env.GITHUB_TOKEN}`, "User-Agent": "omc-hub" } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    res = new Response(await r.text(), { headers: { "Cache-Control": "max-age=120" } });
    ctx && ctx.waitUntil(cache.put(key, res.clone()));
  }
  return res.text();
}

export function onlyStores(name, j, stores) {
  if (stores === "*") return j;
  const pick = o => Object.fromEntries(Object.entries(o || {}).filter(([id]) => stores.includes(id)));
  if (name === "daily.json") return { ...j, days: Object.fromEntries(Object.entries(j.days || {}).map(([d, v]) => [d, pick(v)])) };
  if (name === "weekly-snapshots.json") return { ...j, weeks: (j.weeks || []).map(w => ({ ...w, stores: pick(w.stores) })) };
  if (name === "marketing.json") return { ...j, stores: pick(j.stores) };
  if (name === "payroll.json") return { ...j, periods: Object.fromEntries(Object.entries(j.periods || {}).map(([p, v]) => [p, { ...v, stores: pick(v.stores) }])) };
  return null;   // anything else is corporate-only
}

export const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
