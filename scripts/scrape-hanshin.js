// scrape-hanshin.js — Clover scraper for Hanshin Pocha Oakland
//
// First run: opens a visible Chromium window. You log in to Clover and
// navigate to the Sales Overview for the desired week. The session cookie is
// saved to clover-session.json so future runs are unattended.
//
// Subsequent runs: re-uses the saved session, navigates to Sales Overview,
// extracts Net Sales for the supplied date range.
//
// Usage:
//   node scripts/scrape-hanshin.js                    # interactive — first time
//   node scripts/scrape-hanshin.js 2026-04-20 2026-04-26   # production scrape
//   node scripts/scrape-hanshin.js --explore          # re-dump page for selector hunting
//
// Architecture note: this script is side-tooling. The web app stays a
// single static HTML file. This script's only job is to write a number
// into the STORES array in index.html each Monday.

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const SESSION_PATH = path.join(REPO_ROOT, 'clover-session.json');
const TMP_DIR = path.join(REPO_ROOT, 'tmp');

const args = process.argv.slice(2);
const isExplore = args.includes('--explore');
const dates = args.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const [startDate, endDate] = dates;

// Hanshin's Clover has Business Day End set to 11:00 AM, so a "business
// day" runs 11am-to-11am. To capture a full Mon-Sun pocha week we query
// from Mon 11:00 AM to following Mon 10:59:59 AM (7 business days).
function getArg(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const startTsArg = getArg('--start-ts');
const endTsArg = getArg('--end-ts');

// Wait for Claude (or the user) to create a sentinel file. This lets the
// script run in the background while Dustin interacts with the Chromium
// window — Claude touches the sentinel file from the chat when ready.
async function waitForSignal(label) {
  const sentinel = `/tmp/clover-claude-${label}`;
  console.log(`\n⏳ Waiting for signal: ${sentinel}`);
  console.log(`   (Dustin: tell Claude when ready — Claude will touch this file.)`);
  while (true) {
    try { await fs.access(sentinel); break; } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  await fs.unlink(sentinel).catch(() => {});
  console.log(`✓ Signal received\n`);
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function dumpPage(page, label) {
  await fs.mkdir(TMP_DIR, { recursive: true });
  const stamp = `${label}-${ts()}`;
  const shotPath = path.join(TMP_DIR, `${stamp}.png`);
  const htmlPath = path.join(TMP_DIR, `${stamp}.html`);
  const textPath = path.join(TMP_DIR, `${stamp}.txt`);

  await page.screenshot({ path: shotPath, fullPage: true });
  await fs.writeFile(htmlPath, await page.content());
  const bodyText = await page.evaluate(() => document.body.innerText);
  await fs.writeFile(textPath, bodyText);

  return { shotPath, htmlPath, textPath, bodyText };
}

function analyzeText(text) {
  const moneyMatches = text.match(/\$[\d,]+(?:\.\d{1,2})?/g) || [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const salesContext = [];
  for (let i = 0; i < lines.length; i++) {
    if (/(?:net|total|gross)\s*sales/i.test(lines[i])) {
      salesContext.push({
        line: i,
        label: lines[i].slice(0, 60),
        next1: lines[i + 1]?.slice(0, 60) || '',
        next2: lines[i + 2]?.slice(0, 60) || '',
      });
    }
  }
  return { moneyMatches, salesContext, totalLines: lines.length };
}

async function run() {
  const haveSession = await fileExists(SESSION_PATH);
  console.log(`\n${haveSession ? '✓ Found' : '✗ No'} saved session at clover-session.json`);
  console.log('Launching Chromium…\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext(
    haveSession ? { storageState: SESSION_PATH } : {}
  );
  const page = await context.newPage();

  await page.goto('https://www.clover.com/reporting/sales-overview', { waitUntil: 'domcontentloaded' });

  if (!haveSession) {
    console.log('🔐 In the Chromium window:');
    console.log('   1. Log in to Clover (Hanshin Pocha account)');
    console.log('   2. Navigate to Sales Overview for last week (Apr 20–26)');
    console.log('   3. Wait until Net Sales is visible on the page');
    console.log('   4. Come back here and press ENTER\n');
    await waitForSignal('login-done');
    await context.storageState({ path: SESSION_PATH });
    console.log(`✓ Session saved → clover-session.json (gitignored)\n`);
  } else if (startTsArg && endTsArg) {
    // Direct timestamp control — bypasses date picker quirks. Useful when
    // Clover's Business Day End != midnight and the date picker would
    // truncate the week (as we saw with Apr 20-26 → only Mon-Sat).
    const tryUrl = `https://www.clover.com/reporting/sales-overview?comparison=NO_COMPARISON&startTimestamp=${startTsArg}&endTimestamp=${endTsArg}`;
    console.log(`Navigating with explicit timestamps: ${tryUrl}\n`);
    await page.goto(tryUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);
  } else if (startDate && endDate && !isExplore) {
    // Date-arg mode (Clover may interpret end-date as last biz day end —
    // can drop the final calendar day for late-night business types)
    const tryUrl = `https://www.clover.com/reporting/sales-overview?startDate=${startDate}&endDate=${endDate}`;
    await page.goto(tryUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);
  } else {
    // Just wait for current view to settle
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  console.log(`Page URL: ${page.url()}\n`);

  const { shotPath, htmlPath, textPath, bodyText } = await dumpPage(page, 'sales-overview');
  const { moneyMatches, salesContext, totalLines } = analyzeText(bodyText);

  console.log(`📸 Screenshot: ${path.relative(REPO_ROOT, shotPath)}`);
  console.log(`📄 HTML:       ${path.relative(REPO_ROOT, htmlPath)}`);
  console.log(`📝 Text:       ${path.relative(REPO_ROOT, textPath)}`);
  console.log(`   (${totalLines} non-empty lines)\n`);

  console.log(`💰 Money-shaped strings on page (${moneyMatches.length}):`);
  console.log(`   ${moneyMatches.slice(0, 30).join('  ·  ') || '(none)'}\n`);

  console.log(`🏷  Lines containing /net|total|gross sales/i (${salesContext.length}):`);
  if (salesContext.length === 0) {
    console.log('   (none — selectors may be in shadow DOM or rendered as canvas)');
  } else {
    salesContext.forEach(c => {
      console.log(`   L${c.line}  "${c.label}"`);
      console.log(`            → "${c.next1}"`);
      console.log(`            → "${c.next2}"`);
    });
  }

  console.log('\n✋ Browser is staying open so you can right-click → Inspect on the');
  console.log('   Net Sales number to find a stable selector. When ready:');
  await waitForSignal('close');
  await browser.close();
}

run().catch(err => {
  console.error('Scraper crashed:', err);
  process.exit(1);
});
