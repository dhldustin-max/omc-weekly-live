// scripts/scrape-toast.js — interactive Toast scraper / setup
//
// First run:    opens a Chromium window. Dustin logs in to Toast, navigates
//               to Sales Summary for one store with last week's date range
//               so we can see what the URL + selectors look like.
//               Session saved to toast-session.json (gitignored).
//
// Subsequent runs:  uses the saved session, dumps current page for inspection.
//
// Signal pattern matches scrape-hanshin / scrape-verona — script runs in
// the background while Chromium is on screen, Claude touches a sentinel
// file when Dustin says ready.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  TOAST_LOGIN_URL,
  openToastBrowser,
  saveSession,
  dumpPage,
  parseSalesSummary,
} from './lib/toast.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const SESSION_PATH = path.join(REPO_ROOT, 'toast-session.json');
const TMP_DIR = path.join(REPO_ROOT, 'tmp');

async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function waitForSignal(label) {
  const sentinel = `/tmp/toast-claude-${label}`;
  console.log(`\n⏳ Waiting for signal: ${sentinel}`);
  while (true) {
    if (await fileExists(sentinel)) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await fs.unlink(sentinel).catch(() => {});
  console.log(`✓ Signal received\n`);
}

async function run() {
  const haveSession = await fileExists(SESSION_PATH);
  console.log(`\n${haveSession ? '✓ Found' : '✗ No'} saved Toast session at toast-session.json`);
  console.log(`Launching Chromium (visible)…\n`);

  const { browser, context, page } = await openToastBrowser({
    sessionPath: haveSession ? SESSION_PATH : null,
    headless: false,
  });

  await page.goto(TOAST_LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  if (!haveSession) {
    console.log('🔐 In the Chromium window:');
    console.log('   1. Log in to Toast');
    console.log('   2. Pick ONE store (e.g., Ohgane Concord)');
    console.log('   3. Open Reports → Sales → Sales Summary');
    console.log('   4. Set date range to last week (Apr 20 – Apr 26, 2026)');
    console.log('   5. Wait for "Net sales" total to render');
    console.log('   6. Tell Claude "준비됐어"\n');
    await waitForSignal('login-done');
    await saveSession(context, SESSION_PATH);
    console.log(`✓ Session saved → ${SESSION_PATH} (gitignored)\n`);
  } else {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    console.log('Session is loaded — showing whatever page Toast lands on.\n');
    console.log('Navigate to a store\'s Sales Summary if needed, then tell Claude "준비됐어"\n');
    await waitForSignal('login-done');
  }

  console.log(`Page URL: ${page.url()}\n`);
  const dump = await dumpPage(page, TMP_DIR, 'toast-summary');
  console.log(`📸 Screenshot: ${path.relative(REPO_ROOT, dump.shotPath)}`);
  console.log(`📄 HTML:       ${path.relative(REPO_ROOT, dump.htmlPath)}`);
  console.log(`📝 Text:       ${path.relative(REPO_ROOT, dump.textPath)}\n`);

  // Heuristic: try to find Net sales
  const parsed = parseSalesSummary(dump.bodyText);
  if (parsed) {
    console.log(`🎯 Heuristic Net sales: $${parsed.netSales.toLocaleString()}`);
    console.log(`   (anchor line ${parsed.anchorLine}, value line ${parsed.valueLine})`);
  } else {
    console.log(`⚠️  Heuristic Net sales detection failed — inspect ${path.relative(REPO_ROOT, dump.textPath)}`);
  }

  // Money-shaped strings + label-only lines for context
  const moneyMatches = dump.bodyText.match(/\$[\d,]+(?:\.\d{1,2})?/g) || [];
  console.log(`\n💰 Money-shaped strings on page (${moneyMatches.length}):`);
  console.log(`   ${moneyMatches.slice(0, 30).join('  ·  ') || '(none)'}\n`);

  const lines = dump.bodyText.split('\n').map(l => l.trim()).filter(Boolean);
  const interesting = [];
  for (let i = 0; i < lines.length; i++) {
    if (/(net|gross|total|subtotal)\s*sales/i.test(lines[i])) {
      interesting.push({ line: i, text: lines[i].slice(0, 60), next: lines[i + 1]?.slice(0, 60) });
    }
  }
  if (interesting.length) {
    console.log(`🏷  Sales-related lines:`);
    interesting.forEach(c => console.log(`   L${c.line}  "${c.text}"  →  "${c.next}"`));
  }

  console.log('\n✋ Browser stays open. When done:');
  await waitForSignal('close');
  await browser.close();
}

run().catch(err => {
  console.error('Scraper crashed:', err);
  process.exit(1);
});
