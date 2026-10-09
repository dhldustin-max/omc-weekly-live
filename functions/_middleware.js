// Every request: must be signed in through Cloudflare Access AND listed in USERS.
// USERS (secret, JSON): { "boss@x.com": "*", "manager@x.com": ["ohgane-alameda"] } — "*" = corporate (all stores).
// Managers only reach their store page, the payroll page and the APIs (which filter to their stores).
import { accessEmail } from "../hub/access.js";

const MANAGER_OK = /^\/(store\.html|payroll\.html|nav\.js|chart\.js|data\.js|omc-logo\.png|api\/.*)$/;

export async function onRequest({ request, env, next, data }) {
  const email = await accessEmail(request, env);
  if (!email) return new Response("Please sign in again.", { status: 401 });
  const role = JSON.parse(env.USERS || "{}")[email];
  if (!role) return new Response(`${email} does not have access yet. Ask the office.`, { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  data.user = { email, stores: role === "*" ? "*" : [].concat(role) };

  const url = new URL(request.url), home = data.user.stores === "*" ? "/dashboard.html" : `/store.html?id=${data.user.stores[0]}`;
  if (url.pathname === "/") return Response.redirect(new URL(home, url), 302);
  if (data.user.stores !== "*") {
    if (!MANAGER_OK.test(url.pathname)) return Response.redirect(new URL(home, url), 302);
    if (url.pathname === "/store.html" && !data.user.stores.includes(url.searchParams.get("id"))) return Response.redirect(new URL(home, url), 302);
  }
  return next();
}
