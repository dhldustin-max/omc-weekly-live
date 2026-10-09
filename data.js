// On the OMC hub (Cloudflare, sign-in required) the data files aren't public: the pages' existing
// fetch("daily.json") / fetch("index.html") calls are sent to /api/... which returns only the stores
// the signed-in user may see. On GitHub Pages or a local preview this does nothing.
(() => {
  const HUB = location.hostname.endsWith(".pages.dev") || location.hostname.startsWith("hub.");
  window.OMC_HUB = HUB;
  if (!HUB) return;
  const raw = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const u = typeof input === "string" ? input : input.url;
    const m = /^(?:\.\/)?([\w-]+\.json)(\?.*)?$/.exec(u);
    if (m) return raw("/api/data/" + m[1], init);
    if (/^(?:\.\/)?index\.html$/.test(u)) return raw("/api/stores", init);   // pages parse STORES out of it
    return raw(input, init);
  };
})();
