# Task: Weekly automation — full migration from Cowork to Claude Code

## Status

- ✅ Cowork scheduled task `omc-weekly-monday-reminder` is now **DISABLED** (as of 2026-04-27).
- 🚧 This task is now Claude Code's full responsibility.
- ⚠️ If this isn't working by next Monday (2026-05-04 8am PT), Dustin needs to either (a) manually scrape + commit, or (b) re-enable the Cowork task as fallback (`enabled: true` via Cowork side).

## Goal

Every Monday at 7:00 AM Pacific, automatically:

1. Scrape last week's (Mon-Sun) net sales for all 11 OMC stores from their respective POS systems
2. Optionally refresh Google + Yelp ratings (slow-changing, can be weekly or monthly)
3. Update `STORES` array in `index.html` with new sales numbers
4. Roll over `notes.json` (`weekEnding` updated, current week's typed notes — if any in committed state — moved to `prevNotes`, `consecutiveC` recomputed based on grades)
5. Update week tag in `index.html` ("Week of MMM DD – DD, YYYY")
6. `git commit && git push`
7. Send a notification to Dustin ("✅ Weekly data ready, refresh https://dhldustin-max.github.io/omc-weekly-live/")

## Store-to-POS mapping

| Store | POS | Scraper |
|---|---|---|
| Ohgane Concord | Toast | `toast.js` |
| Oh G Burger Berkeley | Toast | `toast.js` |
| Obento Hayward | Toast | `toast.js` |
| Ohgane Oakland | Verona | `verona.js` |
| Ohgane Alameda | Verona | `verona.js` |
| Tangjip Hayward | Verona | `verona.js` |
| Tangjip Concord | Verona | `verona.js` |
| Tangjip Alameda | Verona | `verona.js` |
| Spoon Berkeley | Verona | `verona.js` |
| Bowl'd Albany | Verona | `verona.js` |
| Hanshin Pocha Oakland | Clover | `clover.js` |

## Architecture

```
omc-weekly-live/
├── index.html
├── notes.json
├── package.json
├── .gitignore                  # Add: sessions/, .env
├── sessions/                   # Saved Playwright auth states (gitignored)
│   ├── toast-session.json
│   ├── verona-session.json
│   └── clover-session.json
├── scripts/
│   ├── scrape/
│   │   ├── toast.js            # Pulls 3 stores
│   │   ├── verona.js           # Pulls 7 stores
│   │   ├── clover.js           # Pulls 1 store (Hanshin)
│   │   └── ratings.js          # Google Maps + Yelp (optional)
│   ├── update-stores.js        # Patches STORES array in index.html
│   ├── rollover-notes.js       # Updates notes.json
│   └── weekly-update.sh        # Orchestrator — Bash entry point
└── tasks/                      # Task spec docs (this file lives here)
```

## Implementation order

### Phase 1 — Foundation (do first)

```bash
npm init -y
npm install -D playwright
npx playwright install chromium
echo "node_modules/" >> .gitignore
echo "sessions/" >> .gitignore
echo ".env" >> .gitignore
mkdir -p scripts/scrape sessions
```

### Phase 2 — One scraper end-to-end

Pick **Verona first** (7 of the 11 stores — biggest impact). Pattern:

```js
// scripts/scrape/verona.js
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION = path.resolve(__dirname, '../../sessions/verona-session.json');

const STORES_TO_SCRAPE = [
  { id: 'ohgane-oakland', veronaName: 'OHGANE KOREAN BBQ' },
  { id: 'ohgane-alameda', veronaName: 'OHGANE ALAMEDA' },
  { id: 'tangjip-hayward', veronaName: 'TANGJIP HAYWARD' },
  { id: 'tangjip-concord', veronaName: 'TANGJIP CONCORD' },
  { id: 'tangjip-alameda', veronaName: 'TANGJIP ALAMEDA' },
  { id: 'spoon-berkeley', veronaName: 'SPOON KOREAN BISTRO' },
  { id: 'bowld-albany', veronaName: 'BOWLD ALBANY' },
];

const [startMMDDYYYY, endMMDDYYYY] = process.argv.slice(2);

const browser = await chromium.launch({ headless: process.env.HEADLESS !== '0' });
const ctx = await browser.newContext({
  storageState: existsSync(SESSION) ? SESSION : undefined,
});
const page = await ctx.newPage();

await page.goto('https://portal-v2.cloudposcenter.com/login');
// If session valid, redirects to merchant list. Otherwise login screen.
// On first run with HEADLESS=0, log in manually then save:
//   await ctx.storageState({ path: SESSION });

const results = [];
for (const store of STORES_TO_SCRAPE) {
  // Click into store from merchant list
  await page.goto('https://portal.cloudposcenter.com/merchant/basis/...');
  await page.click(`button:has-text("${store.veronaName}")`);
  await page.waitForLoadState('networkidle');

  // Get current URL, append date params
  const url = new URL(page.url());
  url.searchParams.set('type', 'SUMMARY');
  url.searchParams.set('date_start', startMMDDYYYY);
  url.searchParams.set('date_end', endMMDDYYYY);
  await page.goto(url.toString());

  // Extract SALES from TOTALS section
  const salesText = await page.locator('text=/^SALES$/').locator('..').locator('..').textContent();
  const sales = parseFloat(salesText.match(/[\d,]+\.\d{2}/)?.[0]?.replace(/,/g, '') || '0');
  results.push({ id: store.id, sales });

  // Back to list
  await page.click('text="Group List"');
  await page.waitForLoadState('networkidle');
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
```

**Selectors will need iteration** — Verona's HTML is messy (table-based, no test IDs). Use Playwright's `page.locator()` with text-based finds. The pattern that worked when scraping manually via Cowork: navigate to store → `?type=SUMMARY&date_start=04/20/2026&date_end=04/26/2026` → find "SALES" label → grab the number next to it.

### Phase 3 — Toast scraper

Toast has cleaner HTML. URL pattern:
```
https://www.toasttab.com/restaurants/admin/reports/sales/sales-summary
  ?startDate=20260420&endDate=20260426
  &datePreset=LAST_WEEK
  &locations=<URL_ENCODED_LOCATION_ID>
```

Each store has a unique `locations=` ID — discoverable from the restaurant picker URL once. Hardcode them after first capture:

```js
const TOAST_LOCATIONS = {
  'ohgane-concord': 'FjdhNScWS%2FaAQFj19Nlwrg%3D%3D',
  'oh-g-burger-berkeley': 'AeX268h5Rw%2Bu9frDWkI6AQ%3D%3D',
  'obento-hayward': 'L2D8AfPWTwGxG6Zfr%2BD2ZA%3D%3D',
};
```

Net Sales selector: look for "Net sales" text in the Revenue Summary card, then sibling dollar amount.

### Phase 4 — Clover scraper (Hanshin)

See companion task: `CLAUDE-TASK-clover-scraper.md`. Either Playwright (similar pattern) or REST API (more robust — get a Clover API token first, see https://docs.clover.com/docs/web-api).

### Phase 5 — Orchestrator

```bash
#!/bin/bash
# scripts/weekly-update.sh
set -e

cd "$(dirname "$0")/.."

# Compute last week's date range (Mon-Sun)
WEEK_START=$(date -v -monday +%Y-%m-%d)         # macOS
WEEK_START_MMDDYYYY=$(date -v -monday +%m/%d/%Y)
WEEK_END=$(date -v -sunday +%Y-%m-%d)
WEEK_END_MMDDYYYY=$(date -v -sunday +%m/%d/%Y)

echo "Scraping week $WEEK_START to $WEEK_END"

# Scrape all 3 sources in parallel where possible
node scripts/scrape/toast.js  $WEEK_START_MMDDYYYY $WEEK_END_MMDDYYYY > /tmp/toast.json &
node scripts/scrape/verona.js $WEEK_START_MMDDYYYY $WEEK_END_MMDDYYYY > /tmp/verona.json &
node scripts/scrape/clover.js $WEEK_START_MMDDYYYY $WEEK_END_MMDDYYYY > /tmp/clover.json &
wait

# Merge results into STORES array in index.html
node scripts/update-stores.js /tmp/toast.json /tmp/verona.json /tmp/clover.json $WEEK_START $WEEK_END

# Roll over notes
node scripts/rollover-notes.js $WEEK_END

# Verify
git diff --stat

# Commit + push
git add index.html notes.json
git commit -m "Weekly auto-update: $WEEK_START to $WEEK_END"
git push

# Notify
osascript -e 'display notification "OMC weekly data deployed. Refresh https://dhldustin-max.github.io/omc-weekly-live/" with title "OMC Weekly Update"'
```

### Phase 6 — Cron

```bash
crontab -e
# Add:
0 7 * * 1 cd ~/projects/omc-weekly-live && /bin/bash scripts/weekly-update.sh >> /tmp/omc-weekly.log 2>&1
```

Make sure Mac doesn't sleep at 7am Monday (already configured by Dustin per CLAUDE.md).

## update-stores.js — patching STORES array

This is the trickiest part because we don't want to rewrite the whole file (risks losing manual edits). Best approach: regex-replace just the `sales: <num>` for each store id.

```js
// scripts/update-stores.js
import fs from 'fs';

const [toastPath, veronaPath, cloverPath, weekStart, weekEnd] = process.argv.slice(2);

const allResults = [
  ...JSON.parse(fs.readFileSync(toastPath)),
  ...JSON.parse(fs.readFileSync(veronaPath)),
  ...JSON.parse(fs.readFileSync(cloverPath)),
];

let html = fs.readFileSync('index.html', 'utf8');

for (const { id, sales } of allResults) {
  // Find the line containing this store and replace `sales: <number>,`
  const re = new RegExp(`(id:\\s*"${id}"[^}]*?sales:\\s*)\\d+(,)`);
  html = html.replace(re, (_, prefix, suffix) => `${prefix}${Math.round(sales)}${suffix}`);
}

// Update week tag
html = html.replace(
  /Week of \w{3} \d+ – \d+, \d{4}/,
  `Week of ${formatRange(weekStart, weekEnd)}`
);
// Update DATA comment
html = html.replace(
  /\/\/ === DATA \(snapshot from .+? scrape.*? ===/,
  `// === DATA (snapshot from ${shortRange(weekStart, weekEnd)} scrape, generated ${new Date().toISOString().slice(0, 10)}) ===`
);

fs.writeFileSync('index.html', html);
console.log(`Updated ${allResults.length} stores`);

function formatRange(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  const m = s.toLocaleString('en', { month: 'short' });
  return `${m} ${s.getDate()} – ${e.getDate()}, ${e.getFullYear()}`;
}
function shortRange(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  const m = s.toLocaleString('en', { month: 'short' });
  return `${m} ${s.getDate()}-${e.getDate()}`;
}
```

## rollover-notes.js

```js
// scripts/rollover-notes.js
import fs from 'fs';
const weekEnd = process.argv[2];

const notes = JSON.parse(fs.readFileSync('notes.json'));
notes.lastUpdated = new Date().toISOString().slice(0, 10);
notes.weekEnding = weekEnd;

// If we tracked typed notes during the week (future feature), move them here.
// For now, just bump the dates. consecutiveC will be updated by the next manual touch
// when grades are reviewed in the meeting.

fs.writeFileSync('notes.json', JSON.stringify(notes, null, 2) + '\n');
```

## Building this incrementally — recommended sequence

Don't try to build everything at once. Order:

1. **Day 1 (today)**: `verona.js` only, hand-run it. Confirm it pulls Tangjip Hayward correctly. Save session.
2. **Day 1**: Extend `verona.js` to all 7 Verona stores. Compare numbers to last week's manual scrape (Apr 20-26 we did together) — should match.
3. **Day 2**: `toast.js` for 3 stores. Same validation.
4. **Day 3**: `clover.js` for Hanshin (see companion task spec).
5. **Day 4**: Wire up `update-stores.js` and run end-to-end (no commit, just verify diff).
6. **Day 5**: Add commit + push.
7. **Day 6**: Schedule via cron. Test by manually triggering.
8. **First real run**: Next Monday 7am, watch the log.

## Things that will probably break (and how to handle)

| Issue | Mitigation |
|---|---|
| Toast/Verona/Clover login session expires | Add a check at start of each scrape — if redirected to login page, send notification "session expired, run interactively to refresh" instead of failing silently |
| Verona DOM changes (their UI is fragile) | Try-catch each store, skip individual failures, report at end which ones succeeded |
| 2FA prompts interactively | Fall back to manual once-a-month re-auth; rest of automation continues |
| Sales values look way off | Add sanity check: if new value differs by >50% from previous week, flag instead of committing |
| Mac asleep at 7am | Cron won't fire. Use `caffeinate` or schedule via `launchd` instead of cron, which can wake the Mac |

## Definition of done

- [ ] All 3 scrapers (Toast, Verona, Clover) work hand-run with saved session
- [ ] Each scraper outputs JSON `[{id, sales}, ...]` for its stores
- [ ] Numbers validated against the Apr 20-26 scrape we did manually (within $5 rounding)
- [ ] `update-stores.js` correctly patches STORES array (verify with `git diff`)
- [ ] `weekly-update.sh` runs end-to-end without errors
- [ ] Cron job set up and survives a reboot
- [ ] First Monday run produces a green diff that gets pushed
- [ ] GitHub Pages reflects the update by 7:30am Monday

## Reference data (Apr 20-26 actuals — for validation)

```
ohgane-oakland         67616  (Verona)
ohgane-concord         74778  (Toast)
ohgane-alameda         65043  (Verona)
tangjip-hayward        44554  (Verona)
tangjip-concord        34123  (Verona)
tangjip-alameda        22100  (Verona)
oh-g-burger-berkeley    6434  (Toast)
obento-hayward          6839  (Toast)
hanshin-pocha-oakland   ?     (Clover - not yet scraped)
spoon-berkeley         15028  (Verona)
bowld-albany           27194  (Verona)
```

When your scraper outputs match these numbers (give or take a dollar), you're done with that POS.

## Companion specs

- `CLAUDE.md` — overall project context (CLAUDE Code reads this on startup)
- `CLAUDE-TASK-rent-based-targets.md` — separate task for updating targets to 3-tier rent-based system
- `CLAUDE-TASK-clover-scraper.md` — deep-dive on Clover specifically (referenced in Phase 4 above)

These three tasks can run in parallel — different scope. Suggested order: weekly automation first (this doc) since it's the highest-leverage change. Rent targets and Clover are smaller scopes that fit naturally into the same scraping foundation.

---

**Last updated:** 2026-04-27. Cowork scheduled task `omc-weekly-monday-reminder` was disabled at this point. Next Monday (2026-05-04) is the first real test of the Claude Code automation.
