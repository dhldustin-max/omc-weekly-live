#!/usr/bin/env node
// scripts/weekly-update.js
//
// Automated weekly Hanshin Pocha update. Designed to run unattended via
// launchd every Monday morning. Steps:
//
//   1. Compute last completed Mon-Sun business week (with 11am biz-day-end)
//   2. Pull repo to get any Cowork-side updates
//   3. Run Playwright scraper against Clover
//   4. Patch index.html STORES array (sales + orders for hanshin-pocha-oakland)
//   5. Update scraper-status.json with last-run info
//   6. git commit + push
//
// Status visibility:
//   - scraper-status.json is committed alongside index.html, so the live
//     web app can fetch it and show a banner when stale or failed.
//   - Errors are logged to ~/Library/Logs/omc-weekly-update.log via launchd
//     stdout/stderr redirection.
//
// Manual run (for testing): node scripts/weekly-update.js
// Manual run with override: node scripts/weekly-update.js --start-ts X --end-ts Y

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

import {
  scrapeHanshin,
  lastBusinessWeekTimestamps,
} from './lib/clover-hanshin.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const SESSION_PATH = path.join(REPO_ROOT, 'clover-session.json');
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
const overrideStart = getArg('--start-ts');
const overrideEnd = getArg('--end-ts');

// ---- helpers --------------------------------------------------------------
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
}

function sh(cmd, opts = {}) {
  log('$', cmd);
  return execSync(cmd, { cwd: REPO_ROOT, stdio: 'inherit', ...opts });
}
function shCapture(cmd) {
  return execSync(cmd, { cwd: REPO_ROOT }).toString().trim();
}

async function readStatus() {
  try { return JSON.parse(await fs.readFile(STATUS_FILE, 'utf-8')); }
  catch { return { consecutiveFailures: 0 }; }
}

async function writeStatus(status) {
  await fs.writeFile(STATUS_FILE, JSON.stringify(status, null, 2) + '\n');
}

async function patchHanshinInIndex({ netSales, orders }) {
  let html = await fs.readFile(INDEX_HTML, 'utf-8');
  const blockRe = /(\{\s*id:\s*"hanshin-pocha-oakland",[\s\S]*?\})/;
  const match = html.match(blockRe);
  if (!match) throw new Error('Hanshin entry not found in STORES array');
  const original = match[1];

  const curSales  = original.match(/sales:\s*(null|\d+)/)?.[1];
  const curOrders = original.match(/orders:\s*(null|\d+)/)?.[1];
  if (curSales === undefined || curOrders === undefined) {
    throw new Error('Could not parse current sales/orders from Hanshin entry — regex out of sync with STORES format');
  }
  const targetSales = String(netSales);
  const targetOrders = String(orders);
  if (curSales === targetSales && curOrders === targetOrders) {
    return { changed: false, prev: { sales: curSales, orders: curOrders } };
  }

  let next = original;
  next = next.replace(/sales:\s*(?:null|\d+)/, `sales: ${netSales}`);
  next = next.replace(/orders:\s*(?:null|\d+)/, `orders: ${orders}`);
  html = html.replace(original, next);
  await fs.writeFile(INDEX_HTML, html);
  return { changed: true, prev: { sales: curSales, orders: curOrders } };
}

function alreadyRanThisWeek(status, weekStartISO) {
  return status?.lastSuccess?.weekStartISO === weekStartISO;
}

// ---- main -----------------------------------------------------------------
async function main() {
  log('=== OMC weekly update — Hanshin Pocha ===');

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
  log(`  startTs=${week.startTs}, endTs=${week.endTs}`);

  // De-dupe: don't re-run for a week we already succeeded on (catch-up safe)
  const prevStatus = await readStatus();
  if (alreadyRanThisWeek(prevStatus, week.weekStartISO) && !overrideStart) {
    log(`✓ Already ran successfully for week ${week.weekStartISO} — skipping (use --start-ts to force)`);
    return;
  }

  // Refresh repo so we don't push onto a stale base
  if (!dryRun) {
    try { sh('git pull --rebase origin main'); }
    catch (e) { log('⚠️  git pull failed — continuing anyway'); }
  }

  // Scrape
  let result;
  try {
    log('Scraping Clover…');
    result = await scrapeHanshin({
      sessionPath: SESSION_PATH,
      startTs: week.startTs,
      endTs: week.endTs,
      headless: true,
      dumpDir: TMP_DIR,
    });
    log(`✓ Net Sales: $${result.netSales}, Orders: ${result.orders}`);
  } catch (err) {
    const msg = err.message || String(err);
    log(`❌ Scrape failed: ${msg}`);
    await writeStatus({
      lastRunAt: new Date().toISOString(),
      lastRunStatus: 'error',
      lastRunScope: 'hanshin',
      lastRunWeekStartISO: week.weekStartISO,
      lastRunWeekEndISO: week.weekEndISO,
      lastError: msg,
      consecutiveFailures: (prevStatus.consecutiveFailures || 0) + 1,
      lastSuccess: prevStatus.lastSuccess || null,
    });
    if (!dryRun && !skipPush) {
      // Even on failure we want the status banner to show on the live site
      try {
        sh('git add scraper-status.json');
        sh(`git commit -m "Weekly auto-update: scrape failed (${week.weekStartISO})"`);
        sh('git push origin main');
      } catch (e) { log('⚠️  Could not push status:', e.message); }
    }
    process.exit(1);
  }

  // Patch index.html
  log('Patching index.html…');
  const patchResult = await patchHanshinInIndex({
    netSales: Math.round(result.netSales),
    orders: result.orders ?? 0,
  });
  if (patchResult.changed) {
    log(`  sales ${patchResult.prev.sales} → ${Math.round(result.netSales)}`);
    log(`  orders ${patchResult.prev.orders} → ${result.orders ?? 0}`);
  } else {
    log(`  no change (already $${Math.round(result.netSales)} / ${result.orders} orders)`);
  }

  // Build status (committed alongside index.html so the live site can read it)
  const successStatus = {
    lastRunAt: new Date().toISOString(),
    lastRunStatus: 'ok',
    lastRunScope: 'hanshin',
    lastRunWeekStartISO: week.weekStartISO,
    lastRunWeekEndISO: week.weekEndISO,
    lastError: null,
    consecutiveFailures: 0,
    lastSuccess: {
      ranAt: new Date().toISOString(),
      weekStartISO: week.weekStartISO,
      weekEndISO: week.weekEndISO,
      netSales: Math.round(result.netSales),
      orders: result.orders ?? 0,
    },
  };

  if (dryRun) {
    log('[dry-run] would write status, commit, push. Done.');
    log(`  status preview: ${JSON.stringify(successStatus, null, 2)}`);
    return;
  }
  await writeStatus(successStatus);

  // Commit + push
  sh('git add index.html scraper-status.json');
  const msg = `Weekly auto-update: Hanshin Pocha ${week.label} — $${Math.round(result.netSales).toLocaleString()} (${result.orders} orders)`;
  // Commit only if there are staged changes (silent no-op on dupe runs)
  try {
    sh(`git commit -m ${JSON.stringify(msg)}`);
    if (!skipPush) sh('git push origin main');
  } catch (e) {
    log('⚠️  No commit (possibly nothing changed):', e.message);
  }

  log('=== Done ===');
}

main().catch(err => {
  log('💥 Fatal:', err.stack || err.message);
  process.exit(1);
});
