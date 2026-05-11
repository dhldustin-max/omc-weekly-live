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

// Parse the FULL Sales Summary page. Toast renders multiple "Net sales"
// labels (Revenue Summary card + Net Sales Summary card + per-category
// breakdowns). The canonical value is the one inside the "Revenue
// Summary" card — that's what manager UI surfaces as the headline.
function parseRevenueSummaryNetSales(text) {
  // Anchor on "Revenue Summary" header, then scan forward for the first
  // "Net sales" label and grab the dollar value within ~30 lines.
  const lines = text.split('\n').map(l => l.trim());
  let anchor = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^Revenue Summary$/i.test(lines[i])) { anchor = i; break; }
  }
  if (anchor === -1) return null;

  const moneyRe = /\$([\d,]+(?:\.\d{1,2})?)/;
  for (let i = anchor + 1; i < Math.min(lines.length, anchor + 30); i++) {
    if (/^Net sales$/i.test(lines[i])) {
      // Net sales line — value is typically on next line or same area
      for (let j = 1; j <= 3 && i + j < lines.length; j++) {
        const m = lines[i + j].match(moneyRe);
        if (m) {
          const v = parseFloat(m[1].replace(/,/g, ''));
          if (!isNaN(v) && v >= 0) return { netSales: v, anchorLine: anchor, netLine: i, valueLine: i + j };
        }
      }
    }
  }
  return null;
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

    // Wait for the Revenue Summary card to actually appear. Toast's
    // SPA loads in stages — partial renders (~9k chars) show breakdown
    // sub-tables but NOT the top-level Revenue Summary card. Manager
    // UI canonical Net Sales lives in that card, so we MUST wait for
    // it. Up to 90 seconds total — Toast can be slow.
    try {
      await page.waitForFunction(
        () => document.body.innerText.includes('Revenue Summary'),
        { timeout: 90000, polling: 1500 }
      );
    } catch {
      throw new Error('REVENUE_SUMMARY_NOT_LOADED — Toast SPA did not render Revenue Summary card within 90s');
    }
    // Even after the header appears, the value may take another beat to populate
    await page.waitForTimeout(2500);

    const text = await page.evaluate(() => document.body.innerText);
    const parsed = parseRevenueSummaryNetSales(text);
    if (!parsed) {
      // Fall back to old heuristic (less accurate but better than nothing)
      const fallback = parseSalesSummary(text);
      if (fallback) {
        return { netSales: fallback.netSales, _warning: 'used_fallback_parser' };
      }
      throw new Error('PARSE_FAILED — Net sales not found even with Revenue Summary anchor');
    }
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
