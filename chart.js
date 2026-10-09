// Grouped ("staggered") bar chart: series side by side within each category, one shared y-axis.
// groupedBars(el, { categories: ["Mon", ...], series: [{ name, values: [..] }], fmt: v => "$" + v })
// Colors are the dashboard's validated categorical slots in fixed order (--series-1..4); never cycled.
// Hover/focus a bar for the exact value; a legend shows for 2+ series; an aria table mirrors the data.
(() => {
  const css = document.createElement("style");
  css.textContent = `
    .gb { --series-1:#2a78d6; --series-2:#eb6834; --series-3:#1baf7a; --series-4:#eda100; position: relative; }
    @media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) .gb { --series-1:#3987e5; --series-2:#d95926; --series-3:#199e70; --series-4:#c98500; } }
    :root[data-theme="dark"] .gb { --series-1:#3987e5; --series-2:#d95926; --series-3:#199e70; --series-4:#c98500; }
    .gb svg { display: block; width: 100%; height: auto; overflow: visible; }
    .gb .ax { font: 11px system-ui, sans-serif; fill: var(--muted); }
    .gb .grid { stroke: var(--grid); stroke-width: 1; }
    .gb rect.bar { cursor: default; }
    .gb rect.hit { fill: transparent; }
    .gb rect.hit:hover + .bar, .gb rect.hit:focus + .bar { opacity: .75; }
    .gb .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--ink-2); margin: 0 0 6px; }
    .gb .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
    .gb .tip { position: absolute; pointer-events: none; background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
      padding: 6px 8px; font-size: 12px; color: var(--ink); box-shadow: 0 4px 14px rgba(0,0,0,.12); white-space: nowrap; display: none; }
    .gb .empty { color: var(--muted); font-size: 13px; padding: 24px 0; text-align: center; }
    .gb table.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }`;
  document.head.appendChild(css);

  window.groupedBars = function (el, { categories, series, fmt = v => String(v), height = 220 }) {
    el.classList.add("gb"); el.innerHTML = "";
    const all = series.flatMap(s => s.values).filter(v => v != null && isFinite(v));
    if (!all.length) { el.innerHTML = `<div class="empty">No data yet</div>`; return; }
    if (series.length > 1) el.insertAdjacentHTML("beforeend", `<div class="legend">${series.map((s, i) =>
      `<span><i style="background:var(--series-${i + 1})"></i>${s.name}</span>`).join("")}</div>`);
    const W = Math.max(320, el.clientWidth || 600), L = 52, R = 8, T = 8;
    const wrap = categories.some(c => String(c).length * 6.2 > (W - L - R) / categories.length - 4);   // long names → two lines
    const B = wrap ? 42 : 28, H = height + (wrap ? 14 : 0);
    const max = niceMax(Math.max(...all, 0)), pw = W - L - R, ph = H - T - B;
    const gw = pw / categories.length, n = series.length;
    const bw = Math.min(48, Math.max(3, (gw * 0.8 - 2 * (n - 1)) / n)), pad = (gw - (bw * n + 2 * (n - 1))) / 2;   // groups centered, bars ≤ 48px
    const y = v => T + ph - (v / max) * ph;
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${series.map(s => s.name).join(" vs ")}">`;
    for (let k = 0; k <= 4; k++) {
      const v = max * k / 4, yy = y(v);
      svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text class="ax" x="${L - 6}" y="${yy + 4}" text-anchor="end">${fmt(v)}</text>`;
    }
    categories.forEach((c, ci) => {
      const gx = L + ci * gw;
      const w = String(c).split(" "), cx = gx + gw / 2;
      svg += wrap && w.length > 1
        ? `<text class="ax" text-anchor="middle"><tspan x="${cx}" y="${H - 22}">${esc(w[0])}</tspan><tspan x="${cx}" y="${H - 8}">${esc(w.slice(1).join(" "))}</tspan></text>`
        : `<text class="ax" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(c)}</text>`;
      series.forEach((s, si) => {
        const v = s.values[ci]; if (v == null || !isFinite(v)) return;
        const x = gx + pad + si * (bw + 2), top = y(Math.max(v, 0)), h = Math.max(1, T + ph - top), r = Math.min(4, bw / 2, h);
        const label = `${esc(c)} · ${esc(s.name)}: ${fmt(v)}`;
        svg += `<rect class="hit" x="${gx + pad + si * (bw + 2) - 1}" y="${T}" width="${bw + 2}" height="${ph}" tabindex="0" data-tip="${label}"/>` +
          `<path class="bar" fill="var(--series-${si + 1})" d="M${x},${T + ph}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${T + ph}Z"/>`;
      });
    });
    svg += `<line stroke="var(--ink-2)" x1="${L}" x2="${W - R}" y1="${T + ph}" y2="${T + ph}"/></svg>`;
    el.insertAdjacentHTML("beforeend", svg + `<div class="tip"></div>` +
      `<table class="sr"><tr><th></th>${series.map(s => `<th>${esc(s.name)}</th>`).join("")}</tr>${categories.map((c, ci) =>
        `<tr><th>${esc(c)}</th>${series.map(s => `<td>${s.values[ci] == null ? "—" : fmt(s.values[ci])}</td>`).join("")}</tr>`).join("")}</table>`);
    const tip = el.querySelector(".tip");
    el.querySelectorAll("rect.hit").forEach(h => {
      const show = () => { tip.textContent = h.dataset.tip; tip.style.display = "block";
        const b = h.getBoundingClientRect(), o = el.getBoundingClientRect();
        tip.style.left = Math.min(o.width - tip.offsetWidth, Math.max(0, b.left - o.left + b.width / 2 - tip.offsetWidth / 2)) + "px";
        tip.style.top = (b.top - o.top + 2) + "px"; };
      h.addEventListener("mouseenter", show); h.addEventListener("focus", show);
      h.addEventListener("mouseleave", () => tip.style.display = "none"); h.addEventListener("blur", () => tip.style.display = "none");
    });
  };
  function niceMax(m) { if (m <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(m))); return [1, 2, 2.5, 5, 10].map(k => k * p).find(v => v >= m); }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
})();
