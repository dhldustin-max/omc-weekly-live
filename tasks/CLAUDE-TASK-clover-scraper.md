# Task: Build Clover scraper for Hanshin Pocha (in Claude Code)

## Why this is in Claude Code, not Cowork

Cowork's sandbox hard-blocks all `clover.com` domains (financial site policy). Claude Code's environment is less restrictive — direct browser navigation and HTTP requests to Clover should work here.

## Goal

Automate weekly scrape of **Hanshin Pocha Oakland** sales from Clover so the Monday 8am scheduled task can pull all 11 stores (currently 10 — Hanshin is the missing one).

**URL:** https://www.clover.com/reporting/sales-overview
**Account:** Dustin's existing Clover login (he'll authenticate once)
**Period:** Last full week (Mon-Sun), e.g. Apr 20-26 for a Monday Apr 27 run

## Approach (Claude Code can use any of these — pick what works)

### Option A: Playwright (recommended)

Claude Code can run Playwright directly. Install once:

```bash
npm install -D playwright
npx playwright install chromium
```

Write `scripts/scrape-hanshin.js`:

```js
import { chromium } from 'playwright';

const [startDate, endDate] = process.argv.slice(2);  // "2026-04-20" "2026-04-26"

const browser = await chromium.launch({ headless: false });  // headless:false on first run for login
const context = await browser.newContext({
  storageState: 'clover-session.json'  // saved auth — created on first manual login
});
const page = await context.newPage();

await page.goto(`https://www.clover.com/reporting/sales-overview?start=${startDate}&end=${endDate}`);
await page.waitForLoadState('networkidle');

// Extract Net Sales — selector to be determined on first inspection
const netSales = await page.locator('[data-testid="net-sales-value"]').textContent();
// Or fall back to visible text scrape:
// const text = await page.textContent('body');
// const match = text.match(/Net Sales[^$]*\$([\d,]+\.?\d*)/);

console.log(JSON.stringify({
  store: 'hanshin-pocha-oakland',
  weekStart: startDate,
  weekEnd: endDate,
  netSales: parseFloat(netSales.replace(/[^0-9.]/g, '')),
}));

await browser.close();
```

**First run (interactive):**

```bash
node scripts/scrape-hanshin.js 2026-04-20 2026-04-26
# Browser opens → Dustin logs in once → save session
```

After login, save the session:

```js
await context.storageState({ path: 'clover-session.json' });
```

`clover-session.json` should be in `.gitignore` (contains auth cookies).

Subsequent runs use the saved session — no login needed unless it expires (typically 30+ days).

### Option B: Direct navigate via Claude Code's built-in browser

If Claude Code has an MCP browser tool (depends on plugins installed), use that. Same pattern: navigate, find Net Sales element, extract value.

### Option C: Clover REST API (most reliable long-term)

If the Playwright approach is fragile, switch to the official API:

1. Dustin goes to Clover Dashboard → Setup → API Tokens → "Create API Token"
2. Permissions: `Read Orders`, `Read Inventory`, `Read Payments`
3. Save token in `.env` (gitignored): `CLOVER_TOKEN=xxx`, `CLOVER_MERCHANT_ID=xxx`
4. Script:

```js
const r = await fetch(
  `https://api.clover.com/v3/merchants/${MID}/orders?` +
  `filter=createdTime>=${startMs}&filter=createdTime<=${endMs}&` +
  `limit=1000`,
  { headers: { Authorization: `Bearer ${TOKEN}` } }
);
const orders = (await r.json()).elements;
const netSales = orders.reduce((sum, o) => sum + (o.total / 100), 0);  // Clover stores in cents
```

API is more stable than scraping (no DOM selector breakage) and faster.

## Integration with existing workflow

After scraping, update `index.html`:

```js
// Find Hanshin in STORES array
{ id: "hanshin-pocha-oakland", ...,
  sales: <SCRAPED_VALUE>,  // was: null
  ...
}
```

Then commit + push:

```bash
git add index.html
git commit -m "Update Hanshin Pocha sales for week of Apr 20-26"
git push
```

GitHub Pages picks it up in 30-60s.

## Validation against rent target

Once we have a real Hanshin number, sanity-check the rent ratio:

```
Rent: $11,000/month
Healthy target (8%): $137,500/month = $31,755/week
Floor (10%):         $110,000/month = $25,404/week
```

If actual weekly sales is ~$15-20K, Hanshin is in **rent stress** (matches the pattern we saw with Tangjip Alameda and Oh G Burger Berkeley) and needs the same intervention discussion.

If actual is ~$25-32K, Hanshin is healthy — current `target: 31755` works.

## Stretch: weekly automation

Once the scraper works manually, wire it into a weekly job:

```bash
# scripts/weekly-update.sh
#!/bin/bash
WEEK_START=$(date -d "last monday" +%Y-%m-%d)
WEEK_END=$(date -d "last sunday" +%Y-%m-%d)
node scripts/scrape-hanshin.js $WEEK_START $WEEK_END > /tmp/hanshin.json

# Parse + update STORES in index.html
node scripts/update-store-sales.js /tmp/hanshin.json hanshin-pocha-oakland

git add index.html
git commit -m "Weekly auto-update: Hanshin Pocha $WEEK_START to $WEEK_END"
git push
```

Add to crontab on Dustin's Mac (or Mac mini once acquired):
```
0 7 * * 1 cd ~/projects/omc-weekly-live && ./scripts/weekly-update.sh >> /tmp/omc.log 2>&1
```

(Monday 7am — runs before the Cowork 8am task, so by 8am all 11 stores are current.)

## Eventually: do all 11 stores in Claude Code

Once Hanshin works, the same pattern can replace the Cowork-side scrape for Toast (3 stores) and Verona (7 stores). That fully migrates the weekly workflow off Cowork to Claude Code, which is more reliable for long-running automation. But this is a later milestone — Hanshin first, then expand if it works well.

## Files to create

```
omc-weekly-live/
├── scripts/
│   ├── scrape-hanshin.js      ← Playwright scraper
│   ├── update-store-sales.js  ← Patches STORES array in index.html
│   └── weekly-update.sh       ← Glue script (later)
├── .gitignore                  ← Add: clover-session.json, .env
└── package.json                ← Add: playwright dep
```

## First run checklist

- [ ] Install Playwright (`npm install -D playwright && npx playwright install chromium`)
- [ ] Write `scrape-hanshin.js` with selector exploration
- [ ] Run once interactively, log in to Clover, save session
- [ ] Confirm Net Sales value matches what Dustin sees in the UI for Apr 20-26
- [ ] Update Hanshin's `sales` field in `index.html`
- [ ] Validate rent ratio (calculation in this doc)
- [ ] Commit + push
- [ ] Verify https://dhldustin-max.github.io/omc-weekly-live/ shows Hanshin sales after 1 min

## When stuck — questions to ask Dustin

- Does Clover have a "Total Sales" vs "Net Sales" distinction? Net excludes refunds/discounts — that's what we want (consistent with Toast/Verona "SALES" / "Net Sales" fields)
- Is "Hanshin Pocha Oakland" the only merchant ID under his Clover account, or does he have multiple? (If single, easy. If multi, need merchant picker)
- Are there 2FA prompts on login? (Affects whether unattended automation is feasible)
