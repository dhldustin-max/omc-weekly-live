// Where a signed-in user may go. Returns null (allowed) or the path to redirect to.
// stores: "*" (corporate) or a list of store ids. Pages serves /store.html as /store, so ".html" is ignored.
const MANAGER_OK = /^\/(store|payroll|marketing|weekly|plan|cash|nav\.js|chart\.js|data\.js|omc-logo\.png|api\/.*)$/;

export function route(stores, href) {
  const url = new URL(href), path = url.pathname.replace(/\.html$/, "");
  const home = stores === "*" ? "/dashboard" : `/store?id=${stores[0]}`;
  if (path === "/" || path === "/index") return home;
  if (stores === "*") return null;
  if (!MANAGER_OK.test(path)) return home;
  if (path === "/store" && !stores.includes(url.searchParams.get("id"))) return home;
  return null;
}
