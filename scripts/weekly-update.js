#!/usr/bin/env node
// scripts/weekly-update.js
//
// Automated weekly update for OMC Hospitality. Designed to run unattended
// via launchd every Monday morning. Replaces the (disabled) Cowork-side
// scheduled task.
//
// Sources:
//   - Hanshin Pocha (Clover, 1 store) — Playwright with saved session
//   - Verona (7 stores) — Playwright with programmatic V1 login
//   - (Toast still TODO — Cowork covers it via fallback for now)
//
// Steps:
//   1. Compute last completed Mon-Sun business week
//   2. git pull (catch any commits from elsewhere)
//   3. Scrape Hanshin → patch index.html
//   4. Scrape Verona  → patch index.html (7 stores)
//   5. Update scraper-status.json with combined run state
//   6. git commit + push
//
// Manual test:    node scripts/weekly-update.js --dry-run
// Force re-run:   node scripts/weekly-update.js --start-ts X --end-ts Y
// Skip push:      node scripts/weekly-update.js --no-push

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

import {
  scrapeHanshin,
  lastBusinessWeekTimestamps,
} from './lib/clover-hanshin.js';
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
const TMP_DIR = path.join(REPO_ROOT, 'tmp');

// ---- arg parsing ----------------------------------------------------------
const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const dryRun = args.includes('--dry-run');
const skipPush = args.includes('--no-push');
const skipHanshin = args.includes('--skip-hanshin');
const skipVerona = args.includes('--skip-verona');
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

async function readStatus() {
  try { return JSON.parse(await fs.readFile(STATUS_FILE, 'utf-8')); }
  catch { return { consecutiveFailures: 0 }; }
}
async function writeStatus(status) {
  await fs.writeFile(STATUS_FILE, JSON.stringify(status, null, 2) + '\n');
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

// Hanshin (Clover) — uses saved Playwright session. Returns { netSales, orders }
// or throws.
async function runHanshin({ startTs, endTs }) {
  const result = await scrapeHanshin({
    sessionPath: HANSHIN_SESSION,
    startTs, endTs,
    headless: true,
    dumpDir: TMP_DIR,
  });
  return result;
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
  const week = overrideStart && overrideEnd
    ? (() => {
        const s = Number(overrideStart), e = Number(overrideEnd);
        const sD = new Date(s), eD = new Date(e);
        return {
          startTs: s, endTs: e,
          weekStartISO: sD.toISOString().slice(0, 10),
          weekEndISO: eD.toISOString().slice(0, 10),
          label: `${sD.toISOString().slice(5, 10)}–${eD.toISOString().slice(5, 10)} (override)`,
        };
      })()
    : lastBusinessWeekTimestamps();
  log(`Target week: ${week.label} [${week.weekStartISO} → ${week.weekEndISO}]`);

  // De-dupe: skip if we already ran this week (catch-up safe)
  const prevStatus = await readStatus();
  const alreadyDone = prevStatus?.lastSuccess?.weekStartISO === week.weekStartISO
    && prevStatus.lastSuccess?.scopes?.includes('verona')
    && prevStatus.lastSuccess?.scopes?.includes('hanshin');
  if (alreadyDone && !overrideStart) {
    log(`✓ Already completed both scrapers for week ${week.weekStartISO} — skipping`);
    return;
  }

  // Refresh repo so we don't push onto a stale base
  if (!dryRun) {
    if (!shTry('git pull --rebase origin main')) {
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
  await writeStatus(newStatus);

  // Commit + push (only if anything to commit)
  sh('git add index.html scraper-status.json');
  const stamp = `${week.label} — ${successes.length} stores ok, ${errors.length} errors`;
  const commitMsg = overallStatus === 'ok'
    ? `Weekly auto-update: ${stamp}`
    : `Weekly auto-update: PARTIAL (${stamp})`;
  if (!shTry(`git commit -m ${JSON.stringify(commitMsg)}`)) {
    log('⚠️  Nothing to commit (no changes)');
  } else if (!skipPush) {
    sh('git push origin main');
  }

  log(`=== Done — overall: ${overallStatus} ===`);
  if (overallStatus !== 'ok') process.exit(2);
}

main().catch(err => {
  log('💥 Fatal:', err.stack || err.message);
  process.exit(1);
});
