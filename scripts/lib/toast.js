// scripts/lib/toast.js
//
// Toast POS scraping. 3 OMC stores live on Toast:
//   - Ohgane Concord
//   - Oh G Burger Berkeley
//   - Obento Hayward
//
// Login: https://www.toasttab.com/login (or /restaurants/admin/...)
// Sales Summary URL pattern (per task spec, will be verified):
//   https://www.toasttab.com/restaurants/admin/reports/sales/sales-summary
//     ?startDate=20260420&endDate=20260426
//     &datePreset=LAST_WEEK
//     &locations=<URL_ENCODED_LOCATION_ID>
//
// Location IDs are stable per store (unlike Verona's session-scoped tokens),
// so we can discover them once and hardcode.

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

export const TOAST_LOGIN_URL = 'https://www.toasttab.com/login';
export const TOAST_REPORTS_BASE = 'https://www.toasttab.com/restaurants/admin/reports/sales/sales-summary';

// Store id → Toast location ID (URL-encoded). Stable per account, so
// hardcoded after first discovery. Ohgane Concord verified live
// 2026-04-28: returned $74,777.62 for Apr 20-26 (matches existing
// STORES value $74,778). Other two from task spec — to be validated.
export const OMC_TOAST_STORES = [
  { id: 'ohgane-concord',       toastName: 'Ohgane Concord',
    locationId: 'FjdhNScWS%2FaAQFj19Nlwrg%3D%3D' },
  { id: 'oh-g-burger-berkeley', toastName: 'Oh G Burger Berkeley',
    locationId: 'AeX268h5Rw%2Bu9frDWkI6AQ%3D%3D' },
  { id: 'obento-hayward',       toastName: 'Obento Hayward',
    locationId: 'L2D8AfPWTwGxG6Zfr%2BD2ZA%3D%3D' },
];

// Format YYYY-MM-DD → YYYYMMDD (Toast's URL format)
export function fmtToastDate(iso) {
  return iso.replace(/-/g, '');
}

function looksLikeLogin(url, text) {
  if (/\/login/i.test(url)) return true;
  if (/sign in|forgot password|password/i.test(text.slice(0, 2000))) return true;
  return false;
}

// Open Toast browser with optional saved session.
export async function openToastBrowser({ sessionPath, headless = true }) {
  let haveSession = false;
  if (sessionPath) {
    try { await fs.access(sessionPath); haveSession = true; } catch {}
  }
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext(
    haveSession ? { storageState: sessionPath } : {}
  );
  const page = await context.newPage();
  return { browser, context, page, haveSession };
}

export async function saveSession(context, sessionPath) {
  await context.storageState({ path: sessionPath });
}

// Page dump utility for selector exploration.
export async function dumpPage(page, dumpDir, label) {
  await fs.mkdir(dumpDir, { recursive: true });
  const stamp = `${label}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const shotPath = path.join(dumpDir, `${stamp}.png`);
  const htmlPath = path.join(dumpDir, `${stamp}.html`);
  const textPath = path.join(dumpDir, `${stamp}.txt`);
  await page.screenshot({ path: shotPath, fullPage: true });
  await fs.writeFile(htmlPath, await page.content());
  const bodyText = await page.evaluate(() => document.body.innerText);
  await fs.writeFile(textPath, bodyText);
  return { shotPath, htmlPath, textPath, bodyText };
}

// Parse Toast's Sales Summary page text dump for "Net sales" value.
// Selector to be verified after first dump — adjust if layout differs.
export function parseSalesSummary(bodyText) {
  const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
  const moneyRe = /^\$?[\d,]+(?:\.\d{1,2})?$/;
  const moneyAnyRe = /\$[\d,]+(?:\.\d{1,2})?/;

  // Strategy A: find "Net sales" label, grab next money line
  for (let i = 0; i < lines.length; i++) {
    if (/^net\s*sales$/i.test(lines[i])) {
      for (let j = 1; j <= 5 && i + j < lines.length; j++) {
        const m = lines[i + j].match(moneyAnyRe);
        if (m) {
          const v = parseFloat(m[0].replace(/[$,]/g, ''));
          if (!isNaN(v) && v >= 0) return { netSales: v, anchorLine: i, valueLine: i + j };
        }
      }
    }
  }
  // Strategy B: line containing "Net sales" + value on same line (tab/space sep)
  for (let i = 0; i < lines.length; i++) {
    if (/net\s*sales/i.test(lines[i])) {
      const m = lines[i].match(moneyAnyRe);
      if (m) {
        const v = parseFloat(m[0].replace(/[$,]/g, ''));
        if (!isNaN(v) && v >= 0) return { netSales: v, anchorLine: i, valueLine: i };
      }
    }
  }
  return null;
}

export function buildSummaryUrl(locationId, startISO, endISO) {
  // Toast URL-encodes the locations param itself in the canonical URL,
  // so we build the query string by hand to preserve the encoded form.
  const start = fmtToastDate(startISO);
  const end = fmtToastDate(endISO);
  return `${TOAST_REPORTS_BASE}?datePreset=CUSTOM&startDate=${start}&endDate=${end}&locations=${locationId}`;
}

// One-shot scrape of a single Toast store. Returns { netSales }.
export async function scrapeToastStore(page, locationId, startISO, endISO) {
  const url = buildSummaryUrl(locationId, startISO, endISO);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  // Toast's React SPA needs extra time for the report to populate
  await page.waitForTimeout(4000);
  const text = await page.evaluate(() => document.body.innerText);
  if (looksLikeLogin(page.url(), text)) {
    throw new Error('TOAST_SESSION_EXPIRED — re-run scrape-toast.js to refresh session');
  }
  const parsed = parseSalesSummary(text);
  if (!parsed) {
    throw new Error('TOAST_PARSE_FAILED — Net sales not found in page text');
  }
  return { netSales: parsed.netSales };
}

// Top-level: open browser with saved session, scrape all 3 OMC Toast stores.
// Toast sessions are reasonably persistent (cookies survive ~weeks), so
// saved-session pattern works — no programmatic login needed for now.
//
// Returns: [{ id, netSales, scrapedAt }, ...]
//          Failed stores are { id, error }.
export async function scrapeAllToast({ sessionPath, startISO, endISO, headless = true }) {
  const { browser, page } = await openToastBrowser({ sessionPath, headless });
  try {
    const results = [];
    for (const store of OMC_TOAST_STORES) {
      try {
        const data = await scrapeToastStore(page, store.locationId, startISO, endISO);
        results.push({
          id: store.id,
          netSales: data.netSales,
          scrapedAt: new Date().toISOString(),
        });
      } catch (err) {
        results.push({ id: store.id, error: err.message, scrapedAt: new Date().toISOString() });
      }
    }
    return results;
  } finally {
    await browser.close();
  }
}
