// POST /api/payroll { fn, store, args } — the payroll page's actions, checked against the user's stores
// and passed to the payroll Apps Script (which builds the Excel, emails it, saves to Drive).
// store "*office" (status + reopen) and "test" are corporate-only.
import { json } from "../../hub/lib.js";

const FNS = ["load", "saveDraft", "submit", "importRoster", "reopen"];

export async function onRequestPost({ request, env, data }) {
  const b = await request.json().catch(() => ({}));
  const corp = data.user.stores === "*";
  if (!FNS.includes(b.fn)) return json({ ok: false, error: "Unknown action" }, 400);
  if (data.user.viewAs && b.fn !== "load") return json({ ok: false, error: "Preview mode — nothing is saved. Exit the preview to make changes." }, 403);
  if (!corp && (!data.user.stores.includes(b.store) || b.fn === "reopen")) return json({ ok: false, error: "Not your store" }, 403);
  const r = await fetch(env.PAYROLL_URL, { method: "POST", body: JSON.stringify({ secret: env.HUB_SECRET, store: b.store, fn: b.fn, args: b.args || [] }), redirect: "follow" });
  const text = await r.text();
  try { return json(JSON.parse(text)); } catch { return json({ ok: false, error: "Payroll service did not answer. Try again." }, 502); }
}
