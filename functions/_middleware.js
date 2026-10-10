// Every request: must be signed in through Cloudflare Access AND listed in USERS.
// USERS (secret, JSON): { "boss@x.com": "*", "manager@x.com": ["ohgane-alameda"] } — "*" = corporate (all stores).
// Managers only reach their store page, the payroll page and the APIs (which filter to their stores).
import { accessEmail } from "../hub/access.js";
import { route } from "../hub/route.js";

export async function onRequest({ request, env, next, data }) {
  const email = await accessEmail(request, env);
  if (!email) return new Response("Please sign in again.", { status: 401 });
  const role = JSON.parse(env.USERS || "{}")[email];
  if (!role) return new Response(`${email} does not have access yet. Ask the office.`, { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  data.user = { email, stores: role === "*" ? "*" : [].concat(role) };
  data.realStores = data.user.stores;
  // Corporate "view as manager" preview (cookie set by /api/view-as); that endpoint itself keeps the real role.
  const as = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)omc_as=([\w-]+)/);
  if (as && data.realStores === "*" && !new URL(request.url).pathname.startsWith("/api/view-as")) data.user = { email, stores: [as[1]], viewAs: as[1] };

  const to = route(data.user.stores, request.url);
  if (to) return Response.redirect(new URL(to, request.url), 302);
  return next();
}
