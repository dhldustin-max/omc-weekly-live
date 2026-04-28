// scripts/lib/clover-hanshin.js
//
// Pure scraping logic for Hanshin Pocha Oakland (Clover). No CLI, no
// terminal interaction — just exposes async functions that take input
// (timestamps, options) and return data (or throw).
//
// Used by both the interactive CLI scraper (scripts/scrape-hanshin.js)
// and the automated weekly job (scripts/weekly-update.js).

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

export const CLOVER_BUSINESS_DAY_END_HOUR_PT = 11;
export const CLOVER_SALES_OVERVIEW_URL = 'https://www.clover.com/reporting/sales-overview';

// Compute Mon→following-Mon timestamps for the *last completed* business
// week, where Hanshin's biz day starts at 11:00 AM Pacific. Returns
// startTs/endTs in ms, plus a human-readable label.
//
// Example: invoked any time on Mon Apr 27, returns Apr 20 11am → Apr 27
// 10:59:59am. Invoked Tue Apr 28, returns the same range (already past).
export function lastBusinessWeekTimestamps(now = new Date()) {
  // Find this week's Monday
  const day = now.getDay(); // 0 = Sun ... 6 = Sat
  const daysSinceMon = (day + 6) % 7; // 0 if Mon, 6 if Sun
  const thisMon = new Date(now);
  thisMon.setHours(0, 0, 0, 0);
  thisMon.setDate(thisMon.getDate() - daysSinceMon);

  // Last week's Monday
  const lastMon = new Date(thisMon);
  lastMon.setDate(thisMon.getDate() - 7);

  // Construct Mon 11am Pacific (DST-aware) as ISO with offset
  const offset = isPacificDST(lastMon) ? '-07:00' : '-08:00';
  const dateStr = lastMon.toISOString().slice(0, 10);
  const startTs = new Date(`${dateStr}T${pad2(CLOVER_BUSINESS_DAY_END_HOUR_PT)}:00:00${offset}`).getTime();
  const endTs = startTs + 7 * 86400 * 1000 - 1;

  const sundayLabel = new Date(lastMon);
  sundayLabel.setDate(lastMon.getDate() + 6);
  return {
    startTs,
    endTs,
    weekStartISO: dateStr,
    weekEndISO: sundayLabel.toISOString().slice(0, 10),
    label: `${shortDate(lastMon)}–${shortDate(sundayLabel)}`,
  };
}

function isPacificDST(date) {
  // US DST: 2nd Sun of March 2am → 1st Sun of November 2am
  const y = date.getFullYear();
  const dstStart = nthSundayOfMonth(y, 2 /* March 0-indexed */, 2);
  const dstEnd = nthSundayOfMonth(y, 10 /* November */, 1);
  return date >= dstStart && date < dstEnd;
}

function nthSundayOfMonth(year, monthIdx, n) {
  const d = new Date(year, monthIdx, 1, 2, 0, 0, 0);
  let count = 0;
  while (count < n) {
    if (d.getDay() === 0) count++;
    if (count < n) d.setDate(d.getDate() + 1);
  }
  return d;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function shortDate(d) {
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
}

// Parse the Clover Sales Overview text dump and pull out the headline
// metrics. The markup is reactish and selectors are unstable, but the
// text-rendered output has a very stable shape (verified via dump):
//
//   Gross Sales
//   Gross Sales
//   $21,009.11
//   Net Sales
//   Net Sales
//   $20,965.88
//   Average Ticket Size
//   ...
//   Orders
//   Orders
//   287
//
// We anchor on these label-then-value sequences.
export function parseSalesOverviewText(bodyText) {
  const lines = bodyText.split('\n').map(s => s.trim()).filter(Boolean);
  const grab = (label, valueRe) => {
    for (let i = 0; i < lines.length - 2; i++) {
      if (lines[i] === label && lines[i + 1] === label) {
        const m = lines[i + 2].match(valueRe);
        if (m) return m[0];
      }
    }
    return null;
  };
  const moneyRe = /\$[\d,]+\.?\d*/;
  const intRe = /^\d[\d,]*$/;

  const grossRaw = grab('Gross Sales', moneyRe);
  const netRaw   = grab('Net Sales',   moneyRe);
  const ticketRaw = grab('Average Ticket Size', moneyRe);
  const ordersRaw = grab('Orders', intRe);
  const collectedRaw = grab('Amount Collected', moneyRe);

  const moneyToNum = s => s ? parseFloat(s.replace(/[^0-9.]/g, '')) : null;
  const intToNum = s => s ? parseInt(s.replace(/,/g, ''), 10) : null;

  return {
    grossSales: moneyToNum(grossRaw),
    netSales: moneyToNum(netRaw),
    avgTicket: moneyToNum(ticketRaw),
    orders: intToNum(ordersRaw),
    amountCollected: moneyToNum(collectedRaw),
  };
}

// Detect whether we got bounced to the login screen (session expired).
// Clover redirects to clover.com/dashboard/login or shows the SSO chrome.
function looksLikeLogin(url, text) {
  if (/login|signin|auth/i.test(url)) return true;
  if (/sign in|forgot password/i.test(text.slice(0, 2000))) return true;
  return false;
}

// Main scrape entry. Headless by default. Throws if session expired.
//
// Options:
//   sessionPath   — required; path to Playwright storageState JSON
//   startTs/endTs — required; ms, defines the week
//   headless      — default true; flip to false for debugging
//   dumpDir       — optional; if set, writes screenshot/html/text dumps
export async function scrapeHanshin(opts) {
  const { sessionPath, startTs, endTs, headless = true, dumpDir = null } = opts;
  if (!sessionPath) throw new Error('sessionPath is required');
  if (!startTs || !endTs) throw new Error('startTs and endTs are required');

  // Verify session file exists
  try { await fs.access(sessionPath); }
  catch { throw new Error(`No saved session at ${sessionPath} — run scrape-hanshin.js interactively to log in first.`); }

  const url = `${CLOVER_SALES_OVERVIEW_URL}?comparison=NO_COMPARISON&startTimestamp=${startTs}&endTimestamp=${endTs}`;
  const browser = await chromium.launch({ headless });
  try {
    const context = await browser.newContext({ storageState: sessionPath });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText);

    if (looksLikeLogin(finalUrl, bodyText)) {
      throw new Error('SESSION_EXPIRED — Clover redirected to login. Re-run interactively: node scripts/scrape-hanshin.js');
    }

    if (dumpDir) {
      await fs.mkdir(dumpDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      await page.screenshot({ path: path.join(dumpDir, `auto-${stamp}.png`), fullPage: true });
      await fs.writeFile(path.join(dumpDir, `auto-${stamp}.html`), await page.content());
      await fs.writeFile(path.join(dumpDir, `auto-${stamp}.txt`), bodyText);
    }

    const parsed = parseSalesOverviewText(bodyText);
    if (parsed.netSales === null) {
      throw new Error('PARSE_FAILED — could not extract Net Sales from Clover text. Page layout may have changed; check tmp/auto-*.txt');
    }
    return {
      ...parsed,
      url: finalUrl,
      scrapedAt: new Date().toISOString(),
    };
  } finally {
    await browser.close();
  }
}

// Interactive login flow — opens a visible Chromium window, lets the
// user log in, then writes storageState to the given path.
export async function loginInteractive(opts) {
  const { sessionPath, waitForSignal } = opts;
  if (!sessionPath) throw new Error('sessionPath is required');
  if (!waitForSignal) throw new Error('waitForSignal callback is required');

  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(CLOVER_SALES_OVERVIEW_URL, { waitUntil: 'domcontentloaded' });
    await waitForSignal(); // Caller signals when login + navigation is done
    await context.storageState({ path: sessionPath });
  } finally {
    await browser.close();
  }
}
