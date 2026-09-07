#!/usr/bin/env node
// scripts/weekly-update.js
//
// Automated weekly update for OMC Hospitality. Designed to run unattended
// via launchd every Monday morning. Replaces the (disabled) Cowork-side
// scheduled task.
//
// Scope: runs via launchd with --include-verona →
//   - Verona (7 stores) — Playwright with programmatic V1 login (.env creds)
//   Toast (6 stores) is handled by the Cowork scheduled task, NOT here.
//   Hanshin Pocha (Clover) CLOSED 08-17-2026 — became TUUM Korean Gastro Pub at the same
//   address (4869 Telegraph Ave), now on Toast. Clover scraping is off by default;
//   pass --include-hanshin only to re-run a historical week.
//
// Steps:
//   1. Compute last completed Mon-Sun business week
//   2. git pull --rebase --autostash (absorb the Cowork Toast commit)
//   3. Scrape Verona → patch index.html + weekly-snapshots.json
//   4. Update scraper-status.json, then git commit + push
//
// Manual test:    node scripts/weekly-update.js --dry-run
// Force re-run:   node scripts/weekly-update.js --start-ts X --end-ts Y
// Skip push:      node scripts/weekly-update.js --no-push

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import dns from 'dns/promises';
import { fileURLToPath } from 'url';

import {
  lastBusinessWeekTimestamps,
} from './lib/clover-hanshin.js';
import {
  scrapeHanshinViaApi,
} from './lib/clover-api.js';
import {
  scrapeAllVerona,
  loadEnvFile,
  fmtVeronaDate,
} from './lib/verona.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const HANSHIN_SESSION = path.join(REPO_ROOT, 'clover-session.json');
const ENV_FILE = path.join(REPO_ROOT, '.env');
const INDEX_HTML = path.join(REPO_ROOT, 'index.html');
const STATUS_FILE = path.join(REPO_ROOT, 'scraper-status.json');
const SNAPSHOTS_FILE = path.join(REPO_ROOT, 'weekly-snapshots.json');
const TMP_DIR = path.join(REPO_ROOT, 'tmp');

// ---- arg parsing ----------------------------------------------------------
const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const dryRun = args.includes('--dry-run');
const skipPush = args.includes('--no-push');
// Scope (as of 08-17-2026): this Mac launchd job scrapes Verona (7) only.
// Toast (6) is handled by the Cowork scheduled task. Verona defaults to SKIPPED
// and is turned on by the plist's --include-verona flag.
// Hanshin (Clover) is CLOSED — skipped unless --include-hanshin is passed.
const skipHanshin = !args.includes('--include-hanshin'); // CLOSED 08-17-2026 (became TUUM, now on Toast)
const skipVerona = !args.includes('--include-verona');
const overrideWeek = getArg('--week'); // YYYY-MM-DD Monday; manual backfill
const overrideStart = getArg('--start-ts');
const overrideEnd = getArg('--end-ts');

// ---- helpers --------------------------------------------------------------
function log(...parts) {
  console.log(`[${new Date().toISOString()}] ${parts.join(' ')}`);
}
function sh(cmd, opts = {}) {
  log('$', cmd);
  return execSync(cmd, { cwd: REPO_ROOT, stdio: 'inherit', ...opts });
}
function shTry(cmd) {
  try { sh(cmd); return true; } catch { return false; }
}

// ---- business-week computation (America/Los_Angeles) ----------------------
// Every store is in California, so the reporting week must resolve to the same
// Mon-Sun window regardless of what timezone this Mac is set to. Dustin
// travels. Before 09-07-2026 the week came from a UTC timestamp, which
// silently shifted the window back a day whenever the Mac was on KST
// (Mon 07:30 KST == Sun 22:30 UTC) -- Verona would have reported Aug 30-Sep 5
// while Toast reported Aug 31-Sep 6. All math below is date-string math
// anchored to the business timezone, so it is travel-proof.
const BIZ_TZ = 'America/Los_Angeles';
const MON_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Stores still on Verona. Golden Wang Donkatsu Dublin moved to Toast on
// 08-17-2026 and is owned by the Cowork task now -- if Verona still returns a
// row for it we must discard it, or it overwrites the correct Toast number.
const VERONA_STORE_IDS = [
  'ohgane-oakland', 'ohgane-alameda',
  'tangjip-hayward', 'tangjip-concord', 'tangjip-alameda',
  'spoon-berkeley', 'bowld-albany',
];
const VERONA_STORE_SET = new Set(VERONA_STORE_IDS);

const ATTEMPTS_FILE = path.join(REPO_ROOT, '.weekly-attempts.json'); // untracked

function bizTodayISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BIZ_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function isoAddDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function isoWeekday(iso) { // 1 = Mon ... 7 = Sun
  const [y, m, d] = iso.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}
function weekFromMonday(mondayISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mondayISO)) throw new Error(`--week expects YYYY-MM-DD, got "${mondayISO}"`);
  if (isoWeekday(mondayISO) !== 1) throw new Error(`--week must be a Monday; ${mondayISO} is not`);
  const weekStartISO = mondayISO;
  const weekEndISO = isoAddDays(mondayISO, 6);
  const [, sm, sd] = weekStartISO.split('-').map(Number);
  const [, em, ed] = weekEndISO.split('-').map(Number);
  const label = `${MON_SHORT[sm - 1]} ${sd}–${MON_SHORT[em - 1]} ${ed}`;
  // startTs/endTs are consumed only by the disabled Clover/Hanshin path.
  const startTs = new Date(`${weekStartISO}T00:00:00`).getTime();
  const endTs = new Date(`${weekEndISO}T23:59:59`).getTime();
  return { startTs, endTs, weekStartISO, weekEndISO, label };
}
function lastCompletedWeekPT() {
  const today = bizTodayISO();
  const thisMonday = isoAddDays(today, -(isoWeekday(today) - 1));
  return weekFromMonday(isoAddDays(thisMonday, -7));
}

// ---- network -------------------------------------------------------------
// launchd fires the job the moment the Mac wakes, routinely before Wi-Fi has
// reassociated. Both 08-31-2026 and 09-06-2026 died exactly this way
// (ERR_INTERNET_DISCONNECTED / "Could not resolve host: github.com").
// Wait for the network instead of dying.
async function hostReachable(host) {
  try { await dns.lookup(host); return true; } catch { return false; }
}
async function waitForNetwork({ attempts = 20, delayMs = 30000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    const [gh, vp] = await Promise.all([
      hostReachable('github.com'),
      hostReachable('online.veronapos.com'),
    ]);
    if (gh && vp) return true;
    log(`⏳ network not ready (${i}/${attempts}) github:${gh} verona:${vp} — retry in ${delayMs / 1000}s`);
    if (i < attempts) await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

// ---- per-week attempt counter (untracked file, never pollutes git) --------
async function readAttempts() {
  try { return JSON.parse(await fs.readFile(ATTEMPTS_FILE, 'utf-8')); }
  catch { return {}; }
}
async function bumpAttempts(weekStartISO) {
  const a = await readAttempts();
  const count = (a.weekStartISO === weekStartISO ? (a.count || 0) : 0) + 1;
  await fs.writeFile(ATTEMPTS_FILE, JSON.stringify({ weekStartISO, count }, null, 2) + '\n');
  return count;
}

// Which Verona stores already have a recorded value for a given week?
async function veronaCoverage(weekStartISO) {
  try {
    const snaps = JSON.parse(await fs.readFile(SNAPSHOTS_FILE, 'utf-8'));
    const wk = (snaps.weeks || []).find(w => w.weekStartISO === weekStartISO);
    if (!wk) return [];
    return VERONA_STORE_IDS.filter(id => wk.stores?.[id]?.sales != null);
  } catch { return []; }
}

// Surface older holes rather than letting them rot unnoticed. The Jun 15-21
// and Aug 24-30 gaps each went undetected for weeks.
async function reportGaps(fromWeekStartISO) {
  const missing = [];
  let iso = fromWeekStartISO;
  for (let i = 0; i < 8; i++) {
    if ((await veronaCoverage(iso)).length === 0) missing.push(iso);
    iso = isoAddDays(iso, -7);
  }
  if (missing.length) {
    log(`⚠️  Weeks with NO Verona data (last 8): ${missing.join(', ')}`);
    log(`   Backfill oldest-first:  node scripts/weekly-update.js --include-verona --week ${missing[missing.length - 1]}`);
  }
}

async function readStatus() {
  try { return JSON.parse(await fs.readFile(STATUS_FILE, 'utf-8')); }
  catch { return { consecutiveFailures: 0 }; }
}
async function writeStatus(status) {
  await fs.writeFile(STATUS_FILE, JSON.stringify(status, null, 2) + '\n');
}

// After scraping + patching index.html, append (or replace) this week's
// entry in weekly-snapshots.json. The live web app reads this file and
// builds the week-picker dropdown so Dustin can scroll back through
// historical weeks. We extract sales/orders/guests directly from the
// (now-current) index.html STORES array — same source the live page
// uses, so no risk of drift.
// onlyStoreIds: restrict the write to the stores THIS run actually scraped.
// Without it, backfilling an older week copied index.html's *current* values
// (which only ever hold one week) over every other source's numbers for that
// week -- on 09-07-2026 the Verona backfill of Aug 24-30 overwrote all six
// Toast stores with the Aug 31-Sep 6 figures.
async function appendWeeklySnapshot({ weekStartISO, weekEndISO, weekLabel, onlyStoreIds = null }) {
  // Parse current STORES out of index.html
  const html = await fs.readFile(INDEX_HTML, 'utf-8');
  const storesBlock = html.match(/const STORES = \[([\s\S]*?)\];/)?.[1];
  if (!storesBlock) throw new Error('STORES array not found while building snapshot');
  const stores = {};
  const entryRe = /\{\s*id:\s*"([^"]+)"[\s\S]*?\}/g;
  let m;
  while ((m = entryRe.exec(storesBlock)) !== null) {
    const eid = m[1];
    const text = m[0];
    const grab = field => {
      const r = text.match(new RegExp(`${field}:\\s*(null|-?\\d+)`));
      if (!r) return null;
      return r[1] === 'null' ? null : Number(r[1]);
    };
    stores[eid] = {
      sales: grab('sales'),
      orders: grab('orders'),
      guests: grab('guests'),
    };
  }

  // Load existing snapshots (or start fresh)
  let snapshots;
  try {
    snapshots = JSON.parse(await fs.readFile(SNAPSHOTS_FILE, 'utf-8'));
  } catch {
    snapshots = {
      _comment: 'Append-only weekly snapshots. Live web app loads this for the week-picker dropdown.',
      weeks: [],
    };
  }
  if (!Array.isArray(snapshots.weeks)) snapshots.weeks = [];

  // Merge into the existing entry for this week (never blind-replace).
  const idx = snapshots.weeks.findIndex(w => w.weekStartISO === weekStartISO);
  const prevStores = idx >= 0 ? (snapshots.weeks[idx].stores || {}) : {};
  const merged = { ...prevStores };
  const writable = onlyStoreIds && onlyStoreIds.length ? onlyStoreIds : Object.keys(stores);
  for (const id of writable) if (stores[id]) merged[id] = stores[id];
  const entry = { weekStartISO, weekEndISO, weekLabel, stores: merged };
  if (idx >= 0) snapshots.weeks[idx] = entry;
  else snapshots.weeks.push(entry);

  // Sort chronologically (oldest first)
  snapshots.weeks.sort((a, b) => a.weekStartISO.localeCompare(b.weekStartISO));

  await fs.writeFile(SNAPSHOTS_FILE, JSON.stringify(snapshots, null, 2) + '\n');
  return { totalWeeks: snapshots.weeks.length, justAdded: idx < 0 };
}

// Update the visible "Week of MMM DD – DD, YYYY" tag at the top of the
// page + the data-snapshot comment line.
// Without this, the page can show fresh STORES values but stale labels.
async function patchWeekLabels({ weekStartISO, weekEndISO }) {
  const [ys, ms, ds] = weekStartISO.split('-').map(Number);
  const [ye, me, de] = weekEndISO.split('-').map(Number);
  const startDate = new Date(ys, ms - 1, ds);
  const endDate = new Date(ye, me - 1, de);
  const monthShort = m => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m];
  const startMon = monthShort(startDate.getMonth());
  const endMon = monthShort(endDate.getMonth());
  // Visible week-tag (e.g. "Apr 27 – May 3, 2026")
  const weekTagText = startMon === endMon
    ? `${startMon} ${startDate.getDate()} – ${endDate.getDate()}, ${endDate.getFullYear()}`
    : `${startMon} ${startDate.getDate()} – ${endMon} ${endDate.getDate()}, ${endDate.getFullYear()}`;
  // Comment label (Apr 27–May 3)
  const commentRange = startMon === endMon
    ? `${startMon} ${startDate.getDate()}-${endDate.getDate()}`
    : `${startMon} ${startDate.getDate()}–${endMon} ${endDate.getDate()}`;
  const today = new Date().toISOString().slice(0, 10);

  let html = await fs.readFile(INDEX_HTML, 'utf-8');
  const before = html;

  html = html.replace(
    /<div class="week-tag">📅 Week of [^<]+<\/div>/,
    `<div class="week-tag">📅 Week of ${weekTagText}</div>`
  );
  html = html.replace(
    /\/\/ === DATA \(snapshot from [^)]+\) ===/,
    `// === DATA (snapshot from ${commentRange} scrape, generated ${today}) ===`
  );
  html = html.replace(
    /\*\*Week:\*\* [^\n]+/,
    `**Week:** ${commentRange}, ${endDate.getFullYear()}`
  );

  if (html !== before) {
    await fs.writeFile(INDEX_HTML, html);
    return { changed: true };
  }
  return { changed: false };
}

// Generic STORES-array patcher. Pass the store id and the fields to update.
// Each fieldsToUpdate value is converted to its source-form (number → "N",
// null → "null"). No-op if nothing changes.
async function patchStoreInIndex(storeId, fieldsToUpdate) {
  let html = await fs.readFile(INDEX_HTML, 'utf-8');
  const blockRe = new RegExp(`(\\{\\s*id:\\s*"${storeId}",[\\s\\S]*?\\})`);
  const match = html.match(blockRe);
  if (!match) throw new Error(`Store entry not found in STORES: ${storeId}`);
  const original = match[1];
  let next = original;

  const changes = {};
  for (const [field, newVal] of Object.entries(fieldsToUpdate)) {
    const cur = original.match(new RegExp(`${field}:\\s*(null|-?\\d+(?:\\.\\d+)?)`))?.[1];
    if (cur === undefined) {
      throw new Error(`Field "${field}" not found on ${storeId} entry`);
    }
    const targetStr = newVal === null ? 'null' : String(newVal);
    if (cur !== targetStr) {
      next = next.replace(
        new RegExp(`${field}:\\s*(?:null|-?\\d+(?:\\.\\d+)?)`),
        `${field}: ${targetStr}`
      );
      changes[field] = { from: cur, to: targetStr };
    }
  }
  if (Object.keys(changes).length === 0) return { changed: false };
  html = html.replace(original, next);
  await fs.writeFile(INDEX_HTML, html);
  return { changed: true, changes };
}

// ---- scrape sources -------------------------------------------------------

// Hanshin (Clover) — now uses the official REST API instead of Playwright.
// Permanent token in .env, no 2FA, no session expiry. Returns
// { netSales, orders } or throws.
async function runHanshin({ startTs, endTs }) {
  const env = await loadEnvFile(ENV_FILE);
  if (!env.CLOVER_API_TOKEN) {
    throw new Error('CLOVER_API_TOKEN missing in .env — falling back is removed; add the token to fix.');
  }
  return scrapeHanshinViaApi({
    apiToken: env.CLOVER_API_TOKEN,
    startTs, endTs,
  });
}

// Verona (7 stores) — programmatic V1 login each run. Always uses
// calendar Mon-Sun (7 days), independent of Hanshin's 11am biz-day
// boundary. So given weekStartISO=Mon, end = Mon+6 (Sun).
async function runVerona({ weekStartISO }) {
  const env = await loadEnvFile(ENV_FILE);
  if (!env.VERONA_EMAIL || !env.VERONA_PASSWORD) {
    throw new Error('VERONA_CREDS_MISSING — .env missing VERONA_EMAIL/VERONA_PASSWORD');
  }
  // weekStartISO = "YYYY-MM-DD" (Mon). End = Mon + 6 = Sun.
  const [y, m, d] = weekStartISO.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const toMDY = dt => `${String(dt.getMonth()+1).padStart(2,'0')}/${String(dt.getDate()).padStart(2,'0')}/${dt.getFullYear()}`;

  const results = await scrapeAllVerona({
    email: env.VERONA_EMAIL,
    password: env.VERONA_PASSWORD,
    startDate: toMDY(start),
    endDate:   toMDY(end),
    headless: true,
  });
  return results;
}

// ---- main -----------------------------------------------------------------
async function main() {
  log('=== OMC weekly update ===');

  // Compute target week (or use overrides)
  const week = overrideWeek
    ? weekFromMonday(overrideWeek)
    : (overrideStart && overrideEnd
        ? (() => {
            const a = Number(overrideStart), b = Number(overrideEnd);
            const sD = new Date(a), eD = new Date(b);
            return {
              startTs: a, endTs: b,
              weekStartISO: sD.toISOString().slice(0, 10),
              weekEndISO: eD.toISOString().slice(0, 10),
              label: 'manual override',
            };
          })()
        : lastCompletedWeekPT());
  log(`Target week: ${week.label} [${week.weekStartISO} -> ${week.weekEndISO}]  (biz tz ${BIZ_TZ}; today there = ${bizTodayISO()})`);

  // De-dupe, coverage-based. The old rule required lastErrors to be EMPTY,
  // so one permanently-broken store (ohgane-oakland has been failing since
  // 08-17-2026) meant the week never counted as done and the job re-scraped
  // forever. Now: done when every live Verona store has a value for the week.
  const prevStatus = await readStatus();
  const covered = await veronaCoverage(week.weekStartISO);
  if (covered.length === VERONA_STORE_IDS.length && !overrideWeek && !overrideStart) {
    log(`✓ Verona already complete for ${week.weekStartISO} (${covered.length}/${VERONA_STORE_IDS.length}) — nothing to do`);
    return;
  }
  const attempt = dryRun ? 0 : await bumpAttempts(week.weekStartISO);
  if (attempt > 8 && covered.length > 0 && !overrideWeek && !overrideStart) {
    log(`⏹  ${week.weekStartISO}: ${covered.length}/${VERONA_STORE_IDS.length} stores captured after ${attempt - 1} attempts — not retrying again. Missing: ${VERONA_STORE_IDS.filter(id => !covered.includes(id)).join(', ')}`);
    return;
  }
  if (covered.length) log(`↻ Retrying ${week.weekStartISO} — have ${covered.length}/${VERONA_STORE_IDS.length}, attempt ${attempt}`);

  await reportGaps(week.weekStartISO);

  // Wait for the network before doing anything that needs it.
  if (!dryRun && !(await waitForNetwork())) {
    log('❌ No network after 10 minutes of retries — aborting cleanly. Nothing committed; the next scheduled run will retry.');
    process.exit(3);
  }

  // Refresh repo so we don't push onto a stale base
  if (!dryRun) {
    if (!shTry('git pull --rebase --autostash origin main')) {
      log('⚠️  git pull failed — continuing anyway');
    }
  }

  const errors = [];
  const successes = []; // { source, storeId(s), values }
  const scrapesRan = [];

  // ---- Hanshin (Clover) ----
  if (!skipHanshin) {
    try {
      log('▶ Scraping Hanshin (Clover)…');
      const r = await runHanshin({ startTs: week.startTs, endTs: week.endTs });
      log(`  ✓ Net Sales $${Math.round(r.netSales)}, Orders ${r.orders}`);
      const patch = await patchStoreInIndex('hanshin-pocha-oakland', {
        sales: Math.round(r.netSales),
        orders: r.orders ?? 0,
      });
      log(`  ${patch.changed ? '🟢 patched' : '⚪ no change'}`);
      successes.push({ source: 'hanshin', storeId: 'hanshin-pocha-oakland',
        netSales: Math.round(r.netSales), orders: r.orders ?? 0 });
      scrapesRan.push('hanshin');
    } catch (err) {
      log(`  ❌ Hanshin failed: ${err.message}`);
      errors.push({ source: 'hanshin', error: err.message });
    }
  } else { log('⏭  Skipping Hanshin'); }

  // ---- Verona (7 stores) ----
  if (!skipVerona) {
    try {
      log('▶ Scraping Verona (7 stores)…');
      const results = await runVerona({ weekStartISO: week.weekStartISO });
      let okCount = 0;
      for (const r of results) {
        if (!VERONA_STORE_SET.has(r.id)) {
          // e.g. golden-wang-donkatsu-dublin, which moved to Toast 08-17-2026.
          // Dropping it here also keeps it out of `errors`, so a stale row can
          // never block the completion check above.
          log(`  ⏭  ${r.id} — no longer a Verona store; ignoring`);
          continue;
        }
        if (r.error) {
          log(`  ❌ ${r.id}: ${r.error}`);
          errors.push({ source: 'verona', storeId: r.id, error: r.error });
          continue;
        }
        const patch = await patchStoreInIndex(r.id, { sales: Math.round(r.sales) });
        log(`  ${patch.changed ? '🟢' : '⚪'} ${r.id.padEnd(22)} $${Math.round(r.sales)}`);
        successes.push({ source: 'verona', storeId: r.id, sales: Math.round(r.sales) });
        okCount++;
      }
      if (okCount > 0) scrapesRan.push('verona');
    } catch (err) {
      log(`  ❌ Verona failed: ${err.message}`);
      errors.push({ source: 'verona', error: err.message });
    }
  } else { log('⏭  Skipping Verona'); }


  // Toast (3 stores) is handled by the Cowork scheduled task, not here.

  // ---- Update visible week labels (only if at least one source succeeded) ----
  if (successes.length > 0) {
    const labelUpdate = await patchWeekLabels({
      weekStartISO: week.weekStartISO,
      weekEndISO:
        // Always Mon + 6 = Sun for label purposes
        (() => {
          const [y, m, d] = week.weekStartISO.split('-').map(Number);
          const dt = new Date(y, m - 1, d);
          dt.setDate(dt.getDate() + 6);
          return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
        })(),
    });
    if (labelUpdate.changed) log('🟢 Week labels updated');

    // Append a snapshot of this week's data so the live site can show
    // the historic-week dropdown.
    const [y, m, d] = week.weekStartISO.split('-').map(Number);
    const sd = new Date(y, m - 1, d);
    const ed = new Date(sd);
    ed.setDate(sd.getDate() + 6);
    const monShort = idx => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][idx];
    const sm = monShort(sd.getMonth());
    const em = monShort(ed.getMonth());
    const weekLabel = sm === em
      ? `${sm} ${sd.getDate()} – ${ed.getDate()}, ${ed.getFullYear()}`
      : `${sm} ${sd.getDate()} – ${em} ${ed.getDate()}, ${ed.getFullYear()}`;
    const weekEndISO = `${ed.getFullYear()}-${String(ed.getMonth()+1).padStart(2,'0')}-${String(ed.getDate()).padStart(2,'0')}`;
    try {
      const snapResult = await appendWeeklySnapshot({
        weekStartISO: week.weekStartISO,
        weekEndISO,
        weekLabel,
        onlyStoreIds: [...new Set(successes.map(x => x.storeId).filter(Boolean))],
      });
      log(`🟢 Snapshot ${snapResult.justAdded ? 'added' : 'updated'} (${snapResult.totalWeeks} weeks total)`);
    } catch (e) {
      log(`⚠️  Snapshot append failed: ${e.message}`);
    }
  }

  // ---- Status + commit -----------------------------------------------------
  const overallStatus = errors.length === 0 ? 'ok' : (successes.length === 0 ? 'error' : 'partial');
  const newStatus = {
    lastRunAt: new Date().toISOString(),
    lastRunStatus: overallStatus,
    lastRunScopes: scrapesRan,
    lastRunWeekStartISO: week.weekStartISO,
    lastRunWeekEndISO: week.weekEndISO,
    lastErrors: errors,
    consecutiveFailures: errors.length > 0 && successes.length === 0
      ? (prevStatus.consecutiveFailures || 0) + 1
      : 0,
    lastSuccess: successes.length > 0
      ? {
          ranAt: new Date().toISOString(),
          weekStartISO: week.weekStartISO,
          weekEndISO: week.weekEndISO,
          scopes: scrapesRan,
          stores: successes,
        }
      : (prevStatus.lastSuccess || null),
  };

  if (dryRun) {
    log('[dry-run] would write status + commit + push.');
    log(`  status preview: ${JSON.stringify(newStatus, null, 2)}`);
    return;
  }
  // Never commit a run that scraped nothing. On 08-31-2026 and 09-06-2026 the
  // job still committed a rewritten scraper-status.json after 0 successful
  // stores, leaving junk commits that then failed to push.
  if (successes.length === 0) {
    log('⚠️  0 stores scraped — leaving the repo untouched (no status write, no commit). Next run retries.');
    log(`   errors: ${JSON.stringify(errors)}`);
    process.exit(2);
  }

  await writeStatus(newStatus);

  // Commit + push (only if anything to commit)
  sh('git add index.html scraper-status.json weekly-snapshots.json');
  const stamp = `${week.label} — ${successes.length} stores ok, ${errors.length} errors`;
  const commitMsg = overallStatus === 'ok'
    ? `Weekly auto-update: ${stamp}`
    : `Weekly auto-update: PARTIAL (${stamp})`;
  if (!shTry(`git commit -m ${JSON.stringify(commitMsg)}`)) {
    log('⚠️  Nothing to commit (no changes)');
  } else if (!skipPush) {
    let pushed = false;
    for (let i = 1; i <= 3; i++) {
      if (shTry('git push origin main')) { pushed = true; break; }
      log(`⚠️  push failed (${i}/3)`);
      if (i < 3) await new Promise(r => setTimeout(r, 20000));
    }
    if (!pushed) {
      log('❌ push failed — the commit is local only. The next run pulls and pushes it.');
    }
  }

  log(`=== Done — overall: ${overallStatus} ===`);
  if (overallStatus !== 'ok') process.exit(2);
}

main().catch(err => {
  log('💥 Fatal:', err.stack || err.message);
  process.exit(1);
});
