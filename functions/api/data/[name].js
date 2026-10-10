// GET /api/data/<file>.json — the dashboard's data files, managers get only their stores' rows.
import { repoFile, onlyStores, json } from "../../../hub/lib.js";

const FILES = ["daily.json", "weekly-snapshots.json", "payroll.json", "marketing.json", "notes.json", "scraper-status.json"];

export async function onRequestGet(ctx) {
  const { params, env, data } = ctx;
  if (!FILES.includes(params.name)) return json({ error: "not found" }, 404);
  const text = await repoFile(env, params.name, ctx);
  if (text == null) return json({}, 404);
  if (data.user.stores === "*") return new Response(text, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const out = onlyStores(params.name, JSON.parse(text), data.user.stores);
  return out ? json(out) : json({ error: "corporate only" }, 403);
}
