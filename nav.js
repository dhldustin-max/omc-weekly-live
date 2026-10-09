// Left menu shared by dashboard.html and labor.html: always visible on wide screens,
// a ☰ button that slides it in on phones. Uses each page's own color tokens.
(() => {
  const PAGES = [["dashboard.html", "Dashboard"], ["labor.html", "Labor"], ["index.html", "Meeting tool"]];
  const here = location.pathname.split("/").pop() || "index.html";
  const css = document.createElement("style");
  css.textContent = `
    .omc-nav { position: fixed; top: 0; left: 0; bottom: 0; width: 190px; background: var(--surface); border-right: 1px solid var(--border);
      padding: 18px 12px; z-index: 20; transition: transform .2s ease; }
    .omc-nav b { display: block; font-size: 13px; color: var(--muted); padding: 0 10px 12px; letter-spacing: .02em; }
    .omc-nav a { display: block; padding: 9px 10px; border-radius: 8px; color: var(--ink); text-decoration: none; font-weight: 600; }
    .omc-nav a:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
    .omc-nav a.on { background: var(--accent); color: #fff; }
    .omc-burger { display: none; position: fixed; top: 10px; left: 10px; z-index: 21; width: 40px; height: 40px; border-radius: 10px;
      border: 1px solid var(--border); background: var(--surface); color: var(--ink); font-size: 20px; cursor: pointer; }
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
  nav.innerHTML = `<b>OMC Hospitality</b>` + PAGES.map(([href, label]) =>
    `<a href="${href}"${href === here ? ' class="on" aria-current="page"' : ""}>${label}</a>`).join("");
  const burger = Object.assign(document.createElement("button"), { className: "omc-burger", textContent: "☰" });
  burger.setAttribute("aria-label", "Menu");
  const veil = Object.assign(document.createElement("div"), { className: "omc-veil" });
  const toggle = () => document.body.classList.toggle("omc-open");
  burger.onclick = toggle; veil.onclick = toggle;
  document.body.prepend(nav, burger, veil);
})();
