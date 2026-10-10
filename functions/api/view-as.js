// GET /api/view-as?store=<id> — corporate only: see the hub exactly as that store's manager would
// (cookie omc_as). /api/view-as with no store ends the preview. Payroll is read-only while previewing.
import STORES from "../../hub/stores.json";

export function onRequestGet({ request, data }) {
  if (data.realStores !== "*") return new Response("Corporate only", { status: 403 });
  const id = new URL(request.url).searchParams.get("store") || "";
  const ok = STORES.some(s => s.id === id);
  const headers = new Headers({ Location: ok ? `/store?id=${id}` : "/dashboard" });
  headers.append("Set-Cookie", ok ? `omc_as=${id}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=7200` : "omc_as=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0");
  return new Response(null, { status: 302, headers });
}
