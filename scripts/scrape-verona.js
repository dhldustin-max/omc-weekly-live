// scripts/scrape-verona.js — interactive Verona scraper
//
// First run:    opens a Chromium window. Dustin logs in, navigates to the
//               TOTALS / SUMMARY page for one store with last week's date
//               range so we can see what the URL + selector look like.
//               Session saved to verona-session.json (gitignored).
//
// Subsequent runs:  uses the saved session, navigates programmatically.
//
// Modes:
//   (no args)               first-time interactive — login + dump
//   --explore               re-dump current view for selector hunting
//   --store <id>            scrape one specific store after login is saved
//
// Signal flow (mirrors scrape-hanshin.js):
//   The script runs in the background while a Chromium window is on
//   screen. The main Claude Code chat watches a sentinel file and signals
//   when Dustin is ready (logged in, on the right page).

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  VERONA_LOGIN_URL,
  VERONA_DASHBOARD_URL,
  VERONA_STORES,
  openVeronaBrowser,
  saveSession,
  dumpPage,
  parseSummaryText,
} from './lib/verona.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const SESSION_PATH = path.join(REPO_ROOT, 'verona-session.json');
const TMP_DIR = path.join(REPO_ROOT, 'tmp');

const args = process.argv.slice(2);

async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function waitForSignal(label) {
  const sentinel = `/tmp/verona-claude-${label}`;
  console.log(`\n⏳ Waiting for signal: ${sentinel}`);
  console.log(`   (Dustin: tell Claude when ready — Claude will touch this file.)`);
  while (true) {
    if (await fileExists(sentinel)) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await fs.unlink(sentinel).catch(() => {});
  console.log(`✓ Signal received\n`);
}

async function run() {
  const haveSession = await fileExists(SESSION_PATH);
  console.log(`\n${haveSession ? '✓ Found' : '✗ No'} saved Verona session at verona-session.json`);
  console.log(`Launching Chromium (visible)…\n`);

  const { browser, context, page } = await openVeronaBrowser({
    sessionPath: haveSession ? SESSION_PATH : null,
    headless: false,
  });

  // Always start at login (works whether session is valid or expired)
  await page.goto(VERONA_LOGIN_URL, { waitUntil: 'domcontentloaded' });

  if (!haveSession) {
    console.log('🔐 In the Chromium window:');
    console.log('   1. Log in to Verona (Cloud POS Center)');
    console.log('   2. Navigate to one store (e.g., TANGJIP HAYWARD)');
    console.log('   3. Open the SUMMARY / TOTALS report');
    console.log('   4. Set date range to last week (Apr 20 – Apr 26, 2026)');
    console.log('   5. Wait for SALES total to render');
    console.log('   6. Come back here and tell Claude "준비됐어"\n');
    await waitForSignal('login-done');
    await saveSession(context, SESSION_PATH);
    console.log(`✓ Session saved → ${SESSION_PATH} (gitignored)\n`);
  } else {
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  console.log(`Page URL: ${page.url()}\n`);

  // Dump current view for selector exploration
  const { shotPath, htmlPath, textPath, bodyText } = await dumpPage(
    page, TMP_DIR, 'verona-summary'
  );

  console.log(`📸 Screenshot: ${path.relative(REPO_ROOT, shotPath)}`);
  console.log(`📄 HTML:       ${path.relative(REPO_ROOT, htmlPath)}`);
  console.log(`📝 Text:       ${path.relative(REPO_ROOT, textPath)}\n`);

  // Heuristic: try to find the SALES number
  const parsed = parseSummaryText(bodyText);
  if (parsed) {
    console.log(`🎯 Heuristic SALES detection: $${parsed.sales.toLocaleString()}`);
    console.log(`   (anchor "SALES" at line ${parsed.anchorLine}, value at line ${parsed.valueLine})`);
  } else {
    console.log(`⚠️  Heuristic SALES detection failed — inspect ${path.relative(REPO_ROOT, textPath)} manually`);
  }

  // Show money-shaped strings for fallback context
  const moneyMatches = bodyText.match(/\$?[\d,]+\.\d{2}/g) || [];
  console.log(`\n💰 Money-shaped strings on page (${moneyMatches.length}):`);
  console.log(`   ${moneyMatches.slice(0, 30).join('  ·  ') || '(none)'}\n`);

  // Show lines containing SALES / TOTAL / NET for context
  const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
  const interesting = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^(sales|total|net|gross|subtotal)$/i.test(lines[i])) {
      interesting.push({ line: i, text: lines[i], next1: lines[i + 1] || '', next2: lines[i + 2] || '' });
    }
  }
  if (interesting.length) {
    console.log(`🏷  Label-only lines (sales/total/net/gross/subtotal):`);
    interesting.forEach(c =>
      console.log(`   L${c.line}  "${c.text}"  →  "${c.next1}"  →  "${c.next2}"`)
    );
  }

  console.log('\n✋ Browser stays open for inspection. Update date range / click around');
  console.log('   if needed. When done:');
  await waitForSignal('close');
  await browser.close();
}

run().catch(err => {
  console.error('Scraper crashed:', err);
  process.exit(1);
});
