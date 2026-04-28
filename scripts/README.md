# OMC scraper scripts

Side tooling. **Not** part of the deployed web app — these run locally on Dustin's
Mac to populate sales data into `index.html`'s `STORES` array each week.

## Why these exist

Cowork's sandbox blocks `clover.com` (financial site policy), so Hanshin
Pocha can't be auto-scraped from the Cowork-side Monday job. Claude Code
running locally can hit Clover directly via Playwright.

## Files

- `scrape-hanshin.js` — opens Clover via Playwright, reads weekly Net Sales
  for Hanshin Pocha Oakland. First run is interactive (Dustin logs in,
  session saved to `clover-session.json`). Subsequent runs are silent.
- `update-store-sales.js` — patches the `sales:` field for a given store id
  inside `index.html`'s `STORES` array. Avoids hand-editing.

## First-time setup

```bash
cd ~/Documents/omc-weekly-live
npm install                          # one time
npx playwright install chromium      # one time
node scripts/scrape-hanshin.js       # interactive: log in → session saved
```

`clover-session.json` and `node_modules/` are gitignored. Don't commit either.

## Weekly run (after first-time setup)

Hanshin's Clover has Business Day End set to **11:00 AM** (a pocha closes
~2am, so the biz day is set so late-night sales attribute to the correct
calendar day). This means a "week" is **Mon 11:00 AM → following Mon
10:59 AM** (7 business days). The Clover date picker, given "Apr 20-26",
returns only Mon-Sat (6 days, missing Sun) — so we drive the URL
directly with millisecond timestamps:

```bash
# Apr 20 11:00 AM PT → Apr 27 10:59:59 AM PT
node scripts/scrape-hanshin.js \
  --start-ts 1776708000000 \
  --end-ts 1777312799999
```

For programmatic use later, compute timestamps with:

```js
// Mon 11:00 AM PT (Apr in PDT, UTC-7)
const start = new Date('2026-04-20T11:00:00-07:00').getTime();
const end = start + 7 * 86400 * 1000 - 1;
```

(For PST months — Nov-Mar — use `-08:00` offset. Will need DST handling
in production.)

The script dumps `tmp/sales-overview-{timestamp}.{png,html,txt}` and
prints heuristic results (money strings + lines mentioning "sales").
Net Sales is the value to take.

See `../tasks/CLAUDE-TASK-clover-scraper.md` for full spec.
