// POST /api/payroll { fn, store, args } — the payroll page's actions, checked against the user's stores
// and passed to the payroll Apps Script (which builds the Excel, emails it, saves to Drive).
// store "*office" (status + reopen) and "test" are corporate-only.
import { json } from "../../hub/lib.js";

const FNS = ["load", "saveDraft", "submit", "importRoster", "reopen", "weeklyGet", "weeklySave", "weeklyAll", "cashGet", "cashSave", "cashReceipt", "cashAll", "cashPickup", "scheduleGet", "scheduleSave"];
const READS = ["load", "weeklyGet", "weeklyAll", "cashGet", "cashAll", "scheduleGet"];   // allowed while previewing as a manager

export async function onRequestPost({ request, env, data }) {
  const b = await request.json().catch(() => ({}));
  const corp = data.user.stores === "*";
  if (!FNS.includes(b.fn)) return json({ ok: false, error: "Unknown action" }, 400);
  if (data.user.viewAs && !READS.includes(b.fn)) return json({ ok: false, error: "Preview mode — nothing is saved. Exit the preview to make changes." }, 403);
  if (!corp && (!data.user.stores.includes(b.store) || ["reopen", "weeklyAll", "cashAll", "cashPickup"].includes(b.fn))) return json({ ok: false, error: "Not your store" }, 403);
  // Cash / schedule: the signed-in email is the signature, so the hub sets it (never the page).
  let args = b.args || [];
  if (b.fn === "cashSave") args = [...args.slice(0, 4), data.user.email];
  if (b.fn === "cashPickup") args = [...args.slice(0, 2), data.user.email];
  if (b.fn === "scheduleSave") args = [...args.slice(0, 5), data.user.email];
  const r = await fetch(env.PAYROLL_URL, { method: "POST", body: JSON.stringify({ secret: env.HUB_SECRET, store: b.store, fn: b.fn, args }), redirect: "follow" });
  const text = await r.text();
  try { return json(JSON.parse(text)); } catch { return json({ ok: false, error: "Payroll service did not answer. Try again." }, 502); }
}
