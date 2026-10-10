// Shared by plan.html and schedule.html (and scripts/sched.test.mjs).
// hoursOf("10-9") → 11 · ("10-2, 5-9") → 8 (split shift = the break) · ("O-C", "10:30", "21:30") → 11 · ("4-close", …).
// No am/pm: a start before 7 is pm, and an end at or before the start is pm. Unreadable → null.
(g => {
  const clock = (x, open, close) => {
    x = x.trim().toLowerCase();
    if (/^o(pen)?$/.test(x)) x = open || ""; else if (/^c(l|lose)?$/.test(x)) x = close || "";
    const m = x.match(/^(\d{1,2})(?::(\d{2}))?\s*(a|p)?m?$/);
    if (!m) return null;
    let h = +m[1] % 24 + (+m[2] || 0) / 60;
    if (m[3] === "p" && h < 12) h += 12; if (m[3] === "a" && h >= 12) h -= 12;
    return { h, ampm: !!m[3] || +m[1] > 12 || /^0\d/.test(x) };   // "4p", "21:30", "09:00" are already exact
  };
  g.hoursOf = (t, open, close) => {
    if (!t || !t.trim()) return null;
    let sum = 0;
    for (const seg of t.split(/,|&|\band\b/)) {
      const p = seg.split(/\s*(?:-|–|~|\bto\b)\s*/);
      if (p.length !== 2) return null;
      const a = clock(p[0], open, close), b = clock(p[1], open, close);
      if (!a || !b) return null;
      let s = a.h, e = b.h;
      if (!a.ampm && s < 7) s += 12;
      if (!b.ampm) while (e <= s) e += 12; else if (e <= s) e += 24;
      if (e - s > 16) return null;
      sum += e - s;
    }
    return Math.round(sum * 4) / 4;
  };
  // Labor budget for the week starting `monday`: expected sales per weekday = average of that weekday over the
  // 4 weeks before; hours = 25% of it ÷ average pay (hourly wages ÷ hours of the latest payroll, else $19).
  g.laborBudget = (daily, periods, id, monday, add) => {
    const paid = Object.keys(periods).sort().reverse().map(p => (periods[p].stores || {})[id]).find(v => v && v.wages && v.hours);
    const rate = paid ? paid.wages / paid.hours : 19;
    const days = [0, 1, 2, 3, 4, 5, 6].map(i => {
      const prev = [1, 2, 3, 4].map(k => (daily[add(monday, i - 7 * k)] || {})[id]).filter(v => v && v.sales > 0);
      const exp = prev.length ? prev.reduce((a, v) => a + v.sales, 0) / prev.length : 0;
      return { exp, hours: exp * 0.25 / rate };
    });
    return { rate, paid: !!paid, days };
  };
})(globalThis);
