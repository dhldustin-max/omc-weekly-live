// scripts/lib/toast-cdp.js
//
// Toast scraper that connects to Dustin's REAL Chrome via CDP (remote
// debugging port). Because Toast's anti-bot detects Playwright-launched
// Chromium and serves a partial SPA, the only reliable way to scrape
// Toast headlessly is to attach to a Chrome instance that Toast already
// trusts — i.e., Dustin's actual logged-in browser.
//
// Setup (one-time):
//   1. Add `chrome-debug` shell alias (see ~/.zshrc) which launches:
//        open -na "Google Chrome" --args --remote-debugging-port=9222 \
//          --user-data-dir="~/Library/Application Support/Google/Chrome-OMC-Debug"
//   2. Sunday evening: run `chrome-debug` in Terminal
//   3. In the Chrome window that opens, log in to Toast once
//   4. Leave the window running (minimize is fine)
//   5. Monday 7:30am cron: weekly-update.js connects via this lib
//
// Reuses Toast restaurant GUIDs from the populateAccessibleRestaurants
// endpoint — Toast normalizes GUIDs in the locations= URL param.

import { chromium } from 'playwright';
import { parseSalesSummary, fmtToastDate, OMC_TOAST_STORES } from './toast.js';

const CDP_ENDPOINT = 'http://localhost:9222';

// Toast restaurant GUIDs discovered 2026-05-11 from
// https://www.toasttab.com/restaurantaccess/populateAccessibleRestaurants
// Each GUID can be passed in the locations= URL param — Toast auto-
// normalizes it to its internal encoded form.
const TOAST_STORE_GUIDS = {
  'ohgane-concord':       '16376135-2716-4bf6-8040-58f5f4d970ae', // Ohgane Concord (1671 Willow Pass)
  'oh-g-burger-berkeley': '01e5f6eb-c879-470f-aef5-fac35a423a01', // Oh G Burger Berkeley (1823 Solano)
  'obento-hayward':       '2f60fc01-f3d6-4f01-b11b-a65fafe0f664', // Obento Hayward (22521 Main)
};

async function connectToCdp() {
  try {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    return browser;
  } catch (e) {
    throw new Error(
      `CDP_UNAVAILABLE — Chrome is not running with --remote-debugging-port=9222 ` +
      `at ${CDP_ENDPOINT}. Run \`chrome-debug\` in Terminal, log in to Toast in ` +
      `the window that opens, and leave it running. Underlying: ${e.message}`
    );
  }
}

async function scrapeOneStore(context, guid, startISO, endISO) {
  const page = await context.newPage();
  try {
    const startMD = startISO.replace(/-/g, '');
    const endMD = endISO.replace(/-/g, '');
    const url =
      `https://www.toasttab.com/restaurants/admin/reports/sales/sales-summary` +
      `?datePreset=CUSTOM&startDate=${startMD}&endDate=${endMD}&locations=${guid}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for SPA to actually render. We poll body length — Toast's
    // fully-rendered Sales Summary is ~30k+ chars; partial loads are
    // ~9-10k. Give it up to 30 seconds.
    let lastLen = 0;
    let stableTicks = 0;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      const len = await page.evaluate(() => document.body.innerText.length);
      if (len > 25000) break;
      if (len === lastLen) {
        stableTicks++;
        if (stableTicks >= 4 && len > 8000) break; // stable partial = good enough
      } else {
        stableTicks = 0;
        lastLen = len;
      }
    }

    const text = await page.evaluate(() => document.body.innerText);
    if (text.length < 5000) {
      throw new Error(`PARTIAL_LOAD — body only ${text.length} chars, Toast not fully rendered`);
    }
    const parsed = parseSalesSummary(text);
    if (!parsed) throw new Error('PARSE_FAILED — Net sales not found');
    return { netSales: parsed.netSales };
  } finally {
    await page.close().catch(() => {});
  }
}

// Top-level: connect to Dustin's running Chrome (CDP), scrape all 3 OMC
// Toast stores via real-browser tabs, return array of results.
//
// Returns: [{ id, netSales, scrapedAt, source: 'toast-cdp' }, ...]
//          Failed stores are { id, error, source: 'toast-cdp' }.
//
// Throws on CDP-unavailable (no Chrome running with debug port).
export async function scrapeAllToastViaCdp({ startISO, endISO }) {
  const browser = await connectToCdp();
  try {
    // Use first available context (the real user's profile)
    const contexts = browser.contexts();
    const context = contexts[0];
    if (!context) throw new Error('No browser context found — Chrome may be in odd state');

    const results = [];
    for (const store of OMC_TOAST_STORES) {
      const guid = TOAST_STORE_GUIDS[store.id];
      if (!guid) {
        results.push({ id: store.id, error: 'No GUID configured', source: 'toast-cdp' });
        continue;
      }
      try {
        const { netSales } = await scrapeOneStore(context, guid, startISO, endISO);
        results.push({
          id: store.id, netSales,
          source: 'toast-cdp',
          scrapedAt: new Date().toISOString(),
        });
      } catch (e) {
        results.push({ id: store.id, error: e.message, source: 'toast-cdp' });
      }
    }
    return results;
  } finally {
    // Don't close the browser — it's Dustin's actual Chrome session
    await browser.close().catch(() => {});
  }
}
