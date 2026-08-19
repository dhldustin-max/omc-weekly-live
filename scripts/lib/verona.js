// scripts/lib/verona.js
//
// Pure Verona POS scraping logic. No CLI, no terminal — just a function
// that takes timestamps, returns store data (or throws). Used by the
// interactive CLI (scripts/scrape-verona.js) and the automated weekly
// job (scripts/weekly-update.js).
//
// Verona POS — actual login URL (not the cloudposcenter.com one in the
// original task spec; that was outdated):
//   https://online.veronapos.com/merchant/basis/login.php
//
// Pattern (will be refined after first interactive run):
//   1. Login → merchant / group list
//   2. For each store, click into it
//   3. Navigate to SUMMARY / TOTALS report
//   4. Set date range to last week (Mon-Sun)
//   5. Find "SALES" label, grab dollar amount
//   6. Back to merchant list, repeat
//
// 7 Verona stores:
//   ohgane-oakland, ohgane-alameda
//   tangjip-hayward, tangjip-concord, tangjip-alameda
//   spoon-berkeley
//   bowld-albany

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

export const VERONA_LOGIN_URL = 'https://online.veronapos.com/merchant/basis/login.php';
export const VERONA_DASHBOARD_URL = 'https://online.veronapos.com/merchant/';

// Store id → exact-prefix match on Verona's merchant-list display name.
// Verona shows e.g. "OHGANE KOREAN BBQ 3915 BROADWAY, OAKLAND CA 94611"
// — the prefix here is what's BEFORE the address, used for store ID
// resolution at discovery time. Names verified against live merchant
// list 2026-04-28 (Note: Ohgane Concord is on Toast per task spec; not
// included here even though Verona has an entry for it.).
// NOTE 08-17-2026: Mad For Sushi Dublin (7222 Regional St) became Golden Wang Donkatsu and
// moved Verona -> Toast. It is now scraped by the Cowork task. Leaving it in this list made
// every weekly run report PARTIAL with:
//   'Store button not found on merchant list: "MAD FOR SUSHI"'
export const OMC_VERONA_STORES = [
  { id: 'ohgane-oakland',     veronaPrefix: 'OHGANE KOREAN BBQ' },
  { id: 'ohgane-alameda',     veronaPrefix: 'OHGANE ALAMEDA' },
  { id: 'tangjip-hayward',    veronaPrefix: 'TANGJIP HAYWARD' },
  { id: 'tangjip-concord',    veronaPrefix: 'TANGJIP CONCORD' },
  { id: 'tangjip-alameda',    veronaPrefix: 'TANGJIP ALAMEDA' },
  { id: 'spoon-berkeley',     veronaPrefix: 'SPOON KOREAN BISTRO' },
  { id: 'bowld-albany',       veronaPrefix: 'BOWLD ALBANY' },
];

// Convert a JS Date / ms-timestamp to MM/DD/YYYY (Verona's URL format).
export function fmtVeronaDate(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  const yyyy = dt.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

// Detect if Verona bounced us to login (session expired).
function looksLikeLogin(url, text) {
  if (/login|signin/i.test(url)) return true;
  if (/sign in|forgot password|password/i.test(text.slice(0, 2000))) return true;
  if (/select a portal version/i.test(text)) return true; // portal-select page
  return false;
}

// Programmatic V1 (Classic Portal) login. Verona's session expires fast
// (<30 min), so the automated weekly job re-logs-in on every run. This
// is the cleanest path — no need to detect-and-recover from expired
// sessions, just always start fresh.
//
// Env vars required:
//   VERONA_EMAIL
//   VERONA_PASSWORD
// (loaded from .env in the repo root — gitignored)
//
// After successful login the page is at the merchant list (m.v?e=...)
// with the session token in the URL.
export async function loginV1(page, { email, password }) {
  if (!email || !password) {
    throw new Error('VERONA_CREDS_MISSING — set VERONA_EMAIL and VERONA_PASSWORD in .env');
  }
  await page.goto(VERONA_LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  // Form fields verified live: input[name="email"], input[name="password"],
  // select[name="timezone"] (default America/New_York — must override to LA),
  // button[type="submit"] text "LOGIN".
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);

  // Select Pacific (Bay Area) timezone. Verona has two options labeled
  // "America: Los Angeles" — using selectOption with the visible label
  // grabs the first match, which is fine.
  try {
    await page.selectOption('select[name="timezone"]', { label: 'America: Los Angeles' });
  } catch {
    // Fallback: try by value patterns or by index
    await page.selectOption('select[name="timezone"]', { index: 2 }).catch(() => {});
  }

  // Submit + wait for navigation to the merchant home
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(2500);

  const finalUrl = page.url();
  const finalText = await page.evaluate(() => document.body.innerText);
  if (looksLikeLogin(finalUrl, finalText)) {
    throw new Error(
      `VERONA_LOGIN_FAILED — landed at ${finalUrl}. Check credentials in .env, ` +
      `or open scrape-verona.js interactively to debug.`
    );
  }
}

// Tiny .env loader (avoids adding the dotenv dependency for one tiny use).
// Returns an object of KEY=VALUE pairs from the file. Comment lines (#)
// and empty lines are skipped. Quoted values are unquoted.
export async function loadEnvFile(envPath) {
  const fs = await import('fs/promises');
  let raw;
  try { raw = await fs.readFile(envPath, 'utf-8'); }
  catch { return {}; }
  const out = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// Parse Verona's SUMMARY-page text dump.
//
// Real layout (verified against Tangjip Hayward Apr 20-26):
//
//   TOTALS
//     SALES         44,553.96   ← what we want (Net Sales before tax/tip)
//     DISCOUNT      -5.00
//     SUBTOTAL      44,548.96   (= SALES + DISCOUNT)
//     TAX           4,923.29
//     SALES TOTAL   49,472.25   (= SUBTOTAL + TAX) — NOT this one
//     SERVICE CHARGE 1,248.55
//     TIP           5,240.22
//     TOTAL         55,961.02   (gross collected — NOT this either)
//
// Each line is tab-separated: "\tSALES\t\t44,553.96". Splitting on
// whitespace gives us [SALES, 44,553.96]. We anchor on the literal
// "TOTALS" header so we don't grab a "SALES" inside the per-payment-
// method breakdown that follows further down (CASH / CREDIT CARD / DOOR
// DASH all have nested SALES rows).
export function parseSummaryText(bodyText) {
  const lines = bodyText.split('\n');
  const moneyRe = /^\$?-?[\d,]+\.\d{2}$/;
  const intRe = /^\d[\d,]*$/;

  let totalsIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'TOTALS') { totalsIdx = i; break; }
  }
  if (totalsIdx === -1) return null;

  let sales = null, salesLine = -1;
  for (let i = totalsIdx + 1; i < Math.min(lines.length, totalsIdx + 20); i++) {
    const tokens = lines[i].trim().split(/\s+/);
    // Want lines whose first token is exactly "SALES" (skip "SALES TOTAL")
    if (tokens[0] !== 'SALES' || tokens.length < 2) continue;
    if (tokens[1] === 'TOTAL') continue; // skip "SALES TOTAL"
    const last = tokens[tokens.length - 1];
    if (!moneyRe.test(last)) continue;
    const v = parseFloat(last.replace(/[$,]/g, ''));
    if (!isNaN(v) && v > 0) {
      sales = v; salesLine = i; break;
    }
  }
  if (sales === null) return null;

  // Try to also pick up order count from elsewhere on the page if available.
  // Verona shows "GUEST COUNT" / order counts in CHECKS section (above TOTALS).
  // We'll skip orders/guests for the v1 — sales alone is enough.

  return { sales, anchorLine: totalsIdx, valueLine: salesLine };
}

// Extract the merchant access token from a Verona report URL.
// Token shape: e=<long hex string> in the query.
export function extractMerchantToken(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('e');
  } catch { return null; }
}

// Build the SUMMARY report URL for a known merchant token + date range.
// Date format: MM/DD/YYYY (URL-encoded).
export function buildSummaryUrl(merchantToken, startDate, endDate) {
  const params = new URLSearchParams({
    e: merchantToken,
    type: 'SUMMARY',
    sub_type: '',
    date_start: startDate,
    date_end: endDate,
  });
  return `https://online.veronapos.com/merchant/basis/m.v?${params}`;
}

// Optional helper: when running interactive, dump the rendered page
// (screenshot + HTML + text) for selector discovery.
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

// Open browser with saved Verona session (or nothing on first run).
// Caller is responsible for closing the browser.
export async function openVeronaBrowser({ sessionPath, headless = true }) {
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

// Saves the current browser context's cookies/localStorage to sessionPath
// so future runs skip the login screen.
export async function saveSession(context, sessionPath) {
  await context.storageState({ path: sessionPath });
}

// Discover the per-session merchant access tokens for OMC's 7 Verona
// stores. Tokens are session-scoped (re-issued on every login), so we
// must rediscover them each run.
//
// Flow:
//   - After loginV1(), the page is at the post-login "Good evening"
//     screen with a "START" button.
//   - Clicking START loads the actual merchant list (all 20 stores in
//     the parent group, including non-OMC ones).
//   - We scan that list for OMC's 7 by prefix-matching the visible name.
//
// Returns: { 'ohgane-oakland': '<token>', 'tangjip-hayward': '<token>', ... }
// Throws if fewer than 7 OMC stores are found.
export async function discoverMerchantTokens(page) {
  // Step into the merchant list via the START button on the post-login screen.
  const startLink = page.locator('a:has-text("START"), a[href*="m.v"]:has-text("START")').first();
  if (await startLink.count()) {
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
      startLink.click(),
    ]);
    await page.waitForTimeout(1500);
  }

  // Now on the merchant list — each store is a <button onclick="...e=token...">.
  const links = await page.evaluate(() => {
    const out = [];
    document
      .querySelectorAll('a[href*="e="], a[href*="m.v"], button[onclick*="e="]')
      .forEach(el => {
        const raw = el.getAttribute('href') || el.getAttribute('onclick') || '';
        const m = raw.match(/e=([a-f0-9]{40,})/);
        if (m) {
          out.push({
            token: m[1],
            text: (el.textContent || '').trim().replace(/\s+/g, ' ')
          });
        }
      });
    return out;
  });

  const map = {};
  for (const store of OMC_VERONA_STORES) {
    const hit = links.find(l => l.text.startsWith(store.veronaPrefix));
    if (hit) map[store.id] = hit.token;
  }
  const missing = OMC_VERONA_STORES.filter(s => !map[s.id]).map(s => s.id);
  if (missing.length) {
    throw new Error(
      `VERONA_DISCOVERY_FAILED — ${missing.length} store(s) not found on merchant list: ` +
      missing.join(', ') + '. Likely SESSION_EXPIRED — run scrape-verona.js to re-login.'
    );
  }
  return map;
}

// Click a specific store's button on the merchant list and scrape its
// SUMMARY page for the given date range.
//
// Crucial detail: Verona re-issues a new session token server-side on
// each navigation (the button onclick has token A, but after the click
// the URL has token B). The merchant-list button tokens cannot be used
// directly for SUMMARY URLs — we MUST click and then modify the
// post-redirect URL. That's why this fn takes a name to click rather
// than a pre-captured token.
//
// Returns { sales } parsed from the page. Throws on parse failure.
export async function scrapeStoreByName(page, storePrefix, startDate, endDate) {
  // Click the matching <button> on the merchant list
  const button = page.locator(`button:has-text("${storePrefix}")`).first();
  if (!await button.count()) {
    throw new Error(`Store button not found on merchant list: "${storePrefix}"`);
  }
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {}),
    button.click(),
  ]);
  await page.waitForTimeout(1500);

  // Server has redirected us to the store's SUMMARY page with a NEW
  // token in the URL. Capture it and tack on the date range params.
  const u = new URL(page.url());
  u.searchParams.set('type', 'SUMMARY');
  u.searchParams.set('sub_type', '');
  u.searchParams.set('date_start', startDate);
  u.searchParams.set('date_end', endDate);
  await page.goto(u.toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const text = await page.evaluate(() => document.body.innerText);
  if (/sign in|forgot password/i.test(text.slice(0, 2000))) {
    throw new Error('SESSION_EXPIRED during scrape');
  }
  const parsed = parseSummaryText(text);
  if (!parsed) {
    throw new Error(`SUMMARY_PARSE_FAILED for ${storePrefix} — page layout may have changed`);
  }
  return { sales: parsed.sales };
}

// Navigate back to the merchant list ("Group List" link in the side menu).
export async function backToMerchantList(page) {
  // The Group List link's href changes per navigation but always exists
  // in the side menu. Click by visible text.
  const link = page.locator('a:has-text("Group List")').first();
  if (await link.count()) {
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
      link.click(),
    ]);
    await page.waitForTimeout(1200);
  }
}

// Top-level scrape: login fresh, navigate to merchant list, click into
// each OMC Verona store, scrape Net Sales, return to list, repeat.
//
// Verona sessions expire fast (<30 min) so we always re-login per run.
// Required: opts.email, opts.password
//
// Returns: [{ id, sales, scrapedAt }, ...] for the 7 OMC Verona stores.
export async function scrapeAllVerona({ email, password, startDate, endDate, headless = true }) {
  const browser = await chromium.launch({ headless });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginV1(page, { email, password });

    // Step into merchant list (click START button on post-login page)
    const startLink = page.locator('a:has-text("START"), a[href*="m.v"]:has-text("START")').first();
    if (await startLink.count()) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
        startLink.click(),
      ]);
      await page.waitForTimeout(1500);
    }

    // (Re)open the merchant list via the post-login START link. Used at
    // startup and to recover after a transient error mid-run.
    async function openMerchantList() {
      const startLink = page.locator('a:has-text("START"), a[href*="m.v"]:has-text("START")').first();
      if (await startLink.count()) {
        await Promise.all([
          page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
          startLink.click(),
        ]);
        await page.waitForTimeout(1500);
      }
    }

    const results = [];
    for (let i = 0; i < OMC_VERONA_STORES.length; i++) {
      const store = OMC_VERONA_STORES[i];
      let data = null, lastErr = null;
      // Up to 2 attempts. A transient network blip (e.g. ERR_NETWORK_CHANGED)
      // or a broken merchant-list state must not kill this store OR cascade
      // into the next one. On failure we hard-recover (re-login + reopen list)
      // then retry once — re-login is safe mid-run and re-issues fresh tokens,
      // and scrapeStoreByName clicks by store name so it works on the new list.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          data = await scrapeStoreByName(page, store.veronaPrefix, startDate, endDate);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < 2) {
            try { await loginV1(page, { email, password }); await openMerchantList(); }
            catch { try { await openMerchantList(); } catch {} }
            await page.waitForTimeout(800);
          }
        }
      }
      if (data) {
        results.push({ id: store.id, sales: data.sales, scrapedAt: new Date().toISOString() });
      } else {
        results.push({ id: store.id, error: lastErr ? lastErr.message : 'unknown', scrapedAt: new Date().toISOString() });
      }
      // Ensure we're back on the merchant list for the next store.
      if (i < OMC_VERONA_STORES.length - 1) {
        await backToMerchantList(page).catch(() => {});
      }
    }
    return results;
  } finally {
    await browser.close();
  }
}
