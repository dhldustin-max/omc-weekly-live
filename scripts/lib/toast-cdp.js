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

// Switched from Playwright connectOverCDP → puppeteer-core because
// Chrome 148+ rejected Playwright's setDownloadBehavior probe with
// "Browser context management is not supported". Puppeteer is Chrome's
// own library and uses a CDP init sequence that current Chrome accepts.
import puppeteer from 'puppeteer-core';
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
    const browser = await puppeteer.connect({
      browserURL: CDP_ENDPOINT,
      defaultViewport: null,
    });
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

async function scrapeOneStore(browser, guid, startISO, endISO) {
  const page = await browser.newPage();
  try {
    // KEY: Toast keeps an active restaurant context per session. The
    // `locations=` URL param only FILTERS, it doesn't switch context —
    // reports still serve data based on the active restaurant. So we
    // navigate to the switch endpoint with returnUrl set to the Sales
    // Summary report we want. Toast switches active restaurant then
    // redirects to the report URL with proper context.
    const startMD = startISO.replace(/-/g, '');
    const endMD = endISO.replace(/-/g, '');
    const returnPath = `/restaurants/admin/reports/sales/sales-summary?datePreset=CUSTOM&startDate=${startMD}&endDate=${endMD}`;
    const url =
      `https://www.toasttab.com/account/switchrestaurant` +
      `?guid=${guid}&returnUrl=${encodeURIComponent(returnPath)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Toast does a redirect to returnUrl after switching — give it a beat
    await page.bringToFront();
    await new Promise(r => setTimeout(r, 1500));

    // Wait for the Revenue Summary card to render. Manager-facing Net
    // Sales lives there; sub-section breakdowns load earlier and have
    // smaller values that we should ignore.
    try {
      await page.waitForFunction(
        () => document.body.innerText.includes('Revenue Summary'),
        { timeout: 90000, polling: 1500 }
      );
    } catch {
      throw new Error('REVENUE_SUMMARY_NOT_LOADED — Toast SPA did not render Revenue Summary card within 90s');
    }
    // Grace period for value to populate after header appears
    await new Promise(r => setTimeout(r, 2500));

    const text = await page.evaluate(() => document.body.innerText);

    // Detect session-expired bounce to login
    if (/auth\.toasttab\.com|please sign in/i.test(page.url() + ' ' + text.slice(0, 500))) {
      throw new Error('TOAST_LOGIN_REQUIRED — log in to Toast in the chrome-debug window');
    }

    const parsed = parseRevenueSummaryNetSales(text);
    if (!parsed) {
      const fallback = parseSalesSummary(text);
      if (fallback) return { netSales: fallback.netSales, _warning: 'used_fallback_parser' };
      throw new Error('PARSE_FAILED — Net sales not found');
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
    const results = [];
    for (const store of OMC_TOAST_STORES) {
      const guid = TOAST_STORE_GUIDS[store.id];
      if (!guid) {
        results.push({ id: store.id, error: 'No GUID configured', source: 'toast-cdp' });
        continue;
      }
      try {
        const { netSales } = await scrapeOneStore(browser, guid, startISO, endISO);
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
    // disconnect (not close) — leave Dustin's Chrome alive
    await browser.disconnect().catch(() => {});
  }
}
