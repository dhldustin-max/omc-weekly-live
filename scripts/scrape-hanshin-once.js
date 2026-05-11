// scripts/scrape-hanshin-once.js
//
// One-shot Hanshin Clover scraper for situations where the persistent
// session save is hanging (saw this on 2026-05-04 — context.storageState()
// was hanging indefinitely after a manual login + 2FA). This script:
//
//   1. Opens visible Chromium (no saved session)
//   2. Lets the user log in + 2FA + navigate
//   3. On signal, scrapes the Sales Overview for the supplied week
//   4. Tries saving the session as a non-blocking best-effort
//   5. Prints { netSales, orders } for downstream processing
//
// Usage:  node scripts/scrape-hanshin-once.js --start-ts <ms> --end-ts <ms>

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseSalesOverviewText, lastBusinessWeekTimestamps } from './lib/clover-hanshin.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const SESSION_PATH = path.join(REPO_ROOT, 'clover-session.json');

const args = process.argv.slice(2);
function getArg(flag) { const i = args.indexOf(flag); return i >= 0 ? args[i+1] : null; }
let startTs = Number(getArg('--start-ts'));
let endTs = Number(getArg('--end-ts'));
if (!startTs || !endTs) {
  const w = lastBusinessWeekTimestamps();
  startTs = w.startTs; endTs = w.endTs;
}

async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function waitForSignal(label) {
  const sentinel = `/tmp/clover-claude-${label}`;
  process.stderr.write(`\n⏳ Waiting for signal: ${sentinel}\n`);
  while (true) {
    if (await fileExists(sentinel)) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await fs.unlink(sentinel).catch(() => {});
  process.stderr.write(`✓ Signal received\n`);
}

(async () => {
  process.stderr.write('Launching Chromium…\n');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://www.clover.com/reporting/sales-overview', { waitUntil: 'domcontentloaded' });

  process.stderr.write('🔐 Log in to Clover (incl. 2FA) and reach Sales Overview, then signal "준비됐어".\n');
  await waitForSignal('login-done');

  // Build URL with the desired week's timestamps and navigate
  const url = `https://www.clover.com/reporting/sales-overview?comparison=NO_COMPARISON&startTimestamp=${startTs}&endTimestamp=${endTs}`;
  process.stderr.write(`Navigating to: ${url}\n`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Extract data
  const text = await page.evaluate(() => document.body.innerText);
  const parsed = parseSalesOverviewText(text);
  if (!parsed || parsed.netSales === null) {
    process.stderr.write('⚠️  parse failed — dumping page text for inspection\n');
    await fs.writeFile(path.join(REPO_ROOT, 'tmp', 'hanshin-debug.txt'), text);
    process.stdout.write(JSON.stringify({ ok: false, error: 'parse_failed' }) + '\n');
    process.exit(1);
  }
  process.stderr.write(`✓ Net Sales: $${parsed.netSales}, Orders: ${parsed.orders}\n`);

  // Print result to stdout (caller can capture)
  process.stdout.write(JSON.stringify({
    ok: true,
    netSales: parsed.netSales,
    orders: parsed.orders,
    grossSales: parsed.grossSales,
    avgTicket: parsed.avgTicket,
  }) + '\n');

  // Best-effort session save (race with timeout — don't hang the script)
  process.stderr.write('Attempting session save (best-effort, 8s timeout)…\n');
  try {
    await Promise.race([
      context.storageState({ path: SESSION_PATH }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('storageState timeout')), 8000)),
    ]);
    process.stderr.write(`✓ Session saved to clover-session.json\n`);
  } catch (e) {
    process.stderr.write(`⚠️  Session save skipped: ${e.message}\n`);
  }

  await browser.close().catch(() => {});
  process.exit(0);
})().catch(err => {
  process.stderr.write(`💥 Crashed: ${err.message}\n`);
  process.exit(1);
});
