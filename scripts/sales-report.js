#!/usr/bin/env node
// Per-store sales table + total from daily.json, for the morning / weekly reports.
//   node scripts/sales-report.js                     # yesterday (America/Los_Angeles)
//   node scripts/sales-report.js 2026-10-01          # one day
//   node scripts/sales-report.js 2026-09-21 2026-09-27   # a range (e.g. last Mon–Sun)
// Compares with the same range 7 days earlier. Prints markdown; stores with no data are listed, never guessed.
import fs from 'fs';

const root = new URL('..', import.meta.url);
const days = JSON.parse(fs.readFileSync(new URL('daily.json', root), 'utf8')).days;
const STORES = new Function('return ' + fs.readFileSync(new URL('index.html', root), 'utf8')
  .match(/const STORES = (\[[\s\S]*?\n  \]);/)[1])();

const add = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const yesterdayPT = add(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date()), -1);
const [from = yesterdayPT, to = from] = process.argv.slice(2);
if (![from, to].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) || from > to) { console.error('usage: sales-report.js [from] [to]'); process.exit(1); }
const range = (a, b) => { const r = []; for (let d = a; d <= b; d = add(d, 1)) r.push(d); return r; };
const cur = range(from, to), prev = cur.map(d => add(d, -7));
// sum only when the store has every day of the range; partial coverage would understate
const sum = (id, ds) => ds.every(d => days[d]?.[id]?.sales != null) ? ds.reduce((a, d) => a + days[d][id].sales, 0) : null;

const money = n => '$' + Math.round(n).toLocaleString('en-US');
const pct = (a, b) => b ? `${a >= b ? '+' : ''}${((a - b) / b * 100).toFixed(1)}%` : '—';
const rows = STORES.filter(s => !s.closedFrom || s.closedFrom > from).map(s => ({   // closed stores drop out from closedFrom
 name: s.name, pos: s.pos, now: sum(s.id, cur), before: sum(s.id, prev) }));
const have = rows.filter(r => r.now != null).sort((a, b) => b.now - a.now), missing = rows.filter(r => r.now == null);
const both = have.filter(r => r.before != null);
const tot = have.reduce((a, r) => a + r.now, 0), totNowCmp = both.reduce((a, r) => a + r.now, 0), totBefore = both.reduce((a, r) => a + r.before, 0);

const label = from === to ? from : `${from} ~ ${to}`;
console.log(`| 매장 | POS | ${label} | 지난주 같은 기간 | 증감 |\n|---|---|---:|---:|---:|`);
have.forEach(r => console.log(`| ${r.name} | ${r.pos} | ${money(r.now)} | ${r.before == null ? '—' : money(r.before)} | ${r.before == null ? '—' : pct(r.now, r.before)} |`));
missing.forEach(r => console.log(`| ${r.name} | ${r.pos} | 자료 없음 | — | — |`));
console.log(`| **합계 (${have.length}/${rows.length}개 매장)** | | **${money(tot)}** | ${both.length ? money(totBefore) : '—'} | ${both.length ? pct(totNowCmp, totBefore) : '—'} |`);
if (missing.length) console.log(`\n자료 없음: ${missing.map(r => r.name).join(', ')}`);
