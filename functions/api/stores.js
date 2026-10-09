// GET /api/stores — the STORES list (names, targets…) in the same text shape the pages parse out of
// index.html, trimmed for managers. hub/stores.json is generated from index.html at build time.
import STORES from "../../hub/stores.json";

export function onRequestGet({ data }) {
  const list = data.user.stores === "*" ? STORES : STORES.filter(s => data.user.stores.includes(s.id));
  return new Response(`const STORES = [\n${list.map(s => "    " + JSON.stringify(s)).join(",\n")}\n  ];`, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
