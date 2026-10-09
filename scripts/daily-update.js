#!/usr/bin/env node
// scripts/daily-update.js — Verona 7 stores, ONE business day per scrape, into daily.json.
//   node scripts/daily-update.js                       # yesterday (America/Los_Angeles)
//   node scripts/daily-update.js --from 2026-09-01 --to 2026-09-29 [--no-push] [--dry-run]
// Toast 6 stores are NOT scraped here — they come from Toast's daily group email
// (scripts/toast-daily-appsscript.gs writes them into the same daily.json).
// daily.json shape: { days: { "YYYY-MM-DD": { storeId: { sales, orders?, guests? } } } }
import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { scrapeAllVerona, loadEnvFile } from './lib/verona.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAILY = path.join(ROOT, 'daily.json');
const VERONA = new Set(['ohgane-oakland','ohgane-alameda','tangjip-hayward','tangjip-concord','tangjip-alameda','spoon-berkeley','bowld-albany']);
const args = process.argv.slice(2);
const arg = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const dryRun = args.includes('--dry-run'), noPush = args.includes('--no-push');
const log = (...p) => console.log(`[${new Date().toISOString()}]`, ...p);

const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const todayPT = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const mdy = iso => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };

const from = arg('--from') || addDays(todayPT(), -1);
const to = arg('--to') || from;
if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new Error(`bad range ${from}..${to}`);

const env = await loadEnvFile(path.join(ROOT, '.env')).catch(() => ({}));
const email = process.env.VERONA_EMAIL || env.VERONA_EMAIL, password = process.env.VERONA_PASSWORD || env.VERONA_PASSWORD;
if (!email || !password) throw new Error('VERONA_EMAIL / VERONA_PASSWORD missing (.env or env)');

const db = JSON.parse(await fs.readFile(DAILY, 'utf8').catch(() => '{"days":{}}'));
db.days ||= {};
let touched = 0, failed = 0;
for (let day = from; day <= to; day = addDays(day, 1)) {
  const have = Object.keys(db.days[day] || {}).filter(id => VERONA.has(id) && db.days[day][id].orders != null).length;
  if (have === VERONA.size && !args.includes('--force')) { log(`⏭  ${day} already 7/7`); continue; }
  log(`▶ ${day}`);
  let results;
  try { results = await scrapeAllVerona({ email, password, startDate: mdy(day), endDate: mdy(day), headless: true }); }
  catch (e) { log(`  ❌ ${day}: ${e.message}`); failed++; continue; }
  db.days[day] ||= {};
  for (const r of results) {
    if (!VERONA.has(r.id)) continue;
    if (r.error) { log(`  ❌ ${r.id}: ${r.error}`); failed++; continue; }
    const R = v => v == null ? null : Math.round(v);
    const row = { sales: R(r.sales), orders: r.orders, guests: r.guests, discount: R(r.discount), alcohol: R(r.alcohol) };
    if (r.hours != null) row.hours = r.hours;
    if (r.channel) Object.assign(row, { dineIn: R(r.channel.dineIn), takeout: R(r.channel.takeout), delivery: R(r.channel.delivery) });
    for (const k of Object.keys(row)) if (row[k] == null) delete row[k];
    db.days[day][r.id] = { ...(db.days[day][r.id] || {}), ...row };
    touched++;
    log(`  🟢 ${r.id.padEnd(18)} $${row.sales}  orders ${row.orders ?? '—'}  guests ${row.guests ?? '—'}  depts: ${(r.departments || []).join(', ')}`);
  }
}
if (dryRun) { log(`dry-run: ${touched} values, ${failed} failures — nothing written`); process.exit(0); }
db.days = Object.fromEntries(Object.entries(db.days).sort(([a], [b]) => a.localeCompare(b)));
db._comment ||= 'Per-business-day sales by store (America/Los_Angeles). Verona: scripts/daily-update.js. Toast: scripts/toast-daily-appsscript.gs (Gmail daily group email). The dashboard builds Day and Month views from this file; weekly-snapshots.json stays the source for Week.';
await fs.writeFile(DAILY, JSON.stringify(db, null, 2) + '\n');
log(`wrote daily.json: ${touched} values, ${failed} failures`);
if (noPush || touched === 0) process.exit(failed ? 2 : 0);
const sh = c => execSync(c, { cwd: ROOT, stdio: 'inherit' });
sh('git add daily.json');
try { sh(`git commit -m "daily: Verona ${from}${to !== from ? '..' + to : ''} (${touched} values)"`); } catch { log('nothing to commit'); process.exit(0); }
sh('git pull --rebase --autostash origin main');
sh('git push origin HEAD:main');
process.exit(failed ? 2 : 0);
