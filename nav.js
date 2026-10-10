// Left menu shared by dashboard.html and labor.html: always visible on wide screens,
// a ☰ button that slides it in on phones. Uses each page's own color tokens.
(() => {
  let PAGES = [["dashboard.html", "Dashboard"], ["store.html", "Stores"], ["labor.html", "Labor"], ["marketing.html", "Marketing"], ["index.html", "Meeting tool"]];
  const bare = h => h.split("?")[0].replace(/\.html$/, "");
  const here = bare(location.pathname.split("/").pop() || "index.html");
  const css = document.createElement("style");
  css.textContent = `
    .omc-nav { position: fixed; top: 0; left: 0; bottom: 0; width: 190px; background: var(--surface, #fff); border-right: 1px solid var(--border, rgba(0,0,0,.1));
      padding: 18px 12px; z-index: 20; transition: transform .2s ease; }
    .omc-nav .logo { display: block; width: 150px; height: auto; margin: 2px 10px 18px; }
    @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .omc-nav .logo { filter: invert(1); } }
    :root[data-theme="dark"] .omc-nav .logo { filter: invert(1); }
    .omc-nav a { display: block; padding: 9px 10px; border-radius: 8px; color: var(--ink, #111); text-decoration: none; font-weight: 600; }
    .omc-nav a:hover { background: color-mix(in srgb, var(--accent, #2a78d6) 8%, transparent); }
    .omc-nav a.on { background: var(--accent, #2a78d6); color: #fff; }
    .omc-burger { display: none; position: fixed; top: 10px; left: 10px; z-index: 21; width: 40px; height: 40px; border-radius: 10px;
      border: 1px solid var(--border, rgba(0,0,0,.1)); background: var(--surface, #fff); color: var(--ink, #111); font-size: 20px; cursor: pointer; }
    .omc-veil { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.35); z-index: 19; }
    body { padding-left: 190px; }
    @media (max-width: 900px) {
      body { padding-left: 0; padding-top: 52px; }
      .omc-burger { display: block; }
      .omc-nav { transform: translateX(-100%); box-shadow: 0 0 24px rgba(0,0,0,.2); padding-top: 62px; }
      body.omc-open .omc-nav { transform: none; }
      body.omc-open .omc-veil { display: block; }
    }`;
  document.head.appendChild(css);
  const nav = document.createElement("nav");
  nav.className = "omc-nav";
  nav.innerHTML = `<a href="dashboard.html" aria-label="OMC Hospitality — dashboard" style="padding:0;background:none"><img class="logo" src="omc-logo.png" alt="OMC Hospitality"></a>` + PAGES.map(([href, label]) =>
    `<a href="${href}"${bare(href) === here ? ' class="on" aria-current="page"' : ""}>${label}</a>`).join("");
  const burger = Object.assign(document.createElement("button"), { className: "omc-burger", textContent: "☰" });
  burger.setAttribute("aria-label", "Menu");
  const veil = Object.assign(document.createElement("div"), { className: "omc-veil" });
  const toggle = () => document.body.classList.toggle("omc-open");
  burger.onclick = toggle; veil.onclick = toggle;
  document.body.prepend(nav, burger, veil);
  // On the hub: add Payroll, and show managers only their store + payroll (the server enforces it too).
  if (window.OMC_HUB) fetch("/api/me").then(r => r.json()).then(me => {
    PAGES = me.stores === "*"
      ? [["dashboard.html", "Dashboard"], ["store.html", "Stores"], ["labor.html", "Labor"], ["marketing.html", "Marketing"], ["payroll.html", "Payroll"], ["meeting.html", "Meeting tool"]]
      : [[`store.html?id=${me.stores[0]}`, "My store"], ["marketing.html", "Marketing"], ["payroll.html", "Payroll"]];
    nav.querySelectorAll("a:not([aria-label])").forEach(a => a.remove());
    nav.insertAdjacentHTML("beforeend", PAGES.map(([href, label]) =>
      `<a href="${href}"${bare(href) === here ? ' class="on" aria-current="page"' : ""}>${label}</a>`).join("") +
      `<div style="position:absolute;bottom:14px;left:22px;right:12px;font-size:11px;color:var(--muted, #888);overflow-wrap:anywhere">${me.email}</div>`);
    // Corporate can preview a store manager's view; while previewing, a bar says so with an exit link.
    if (me.viewAs) document.body.insertAdjacentHTML("afterbegin", `<div style="position:sticky;top:0;z-index:40;background:#fab219;color:#0b0b0b;padding:8px 14px;font:600 13px system-ui;text-align:center">Preview: you are seeing what the ${me.viewAs} manager sees · payroll is read-only · <a href="/api/view-as" style="color:#0b0b0b">Exit preview</a></div>`);
    else if (me.stores === "*") fetch("/api/stores").then(r => r.text()).then(t => {
      const list = new Function("return " + t.match(/const STORES = (\[[\s\S]*?\n  \]);/)[1])();
      nav.insertAdjacentHTML("beforeend", `<select aria-label="Preview as a store manager" style="margin:14px 10px 0;width:calc(100% - 20px);font:12px system-ui;padding:6px;border-radius:8px;border:1px solid var(--border, #ddd);background:var(--surface, #fff);color:var(--ink, #111)" onchange="if(this.value)location='/api/view-as?store='+this.value"><option value="">Preview as manager…</option>${list.map(s => `<option value="${s.id}">${s.name}</option>`).join("")}</select>`);
    });
  }).catch(() => {});
})();
