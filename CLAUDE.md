# OMC Hospitality Weekly Ops — Project Context

## What this is

A live web app at **https://dhldustin-max.github.io/omc-weekly-live/** used by Dustin (Director) to run weekly Monday manager meetings across 13 OMC Hospitality restaurants in the Bay Area.

The app shows Sales vs Target, Prime Cost calculation, A/B/C grade, manager meeting notes, and concept-level comparisons. Updates weekly with last week's POS data.

**Repo:** https://github.com/dhldustin-max/omc-weekly-live (deployed via GitHub Pages from `main` branch)

## File structure

```
index.html             # Meeting tool (HTML + CSS + JS in one file); STORES array = targets source of truth
dashboard.html         # At-a-glance overview page (reads STORES from index.html + the two JSON files)
weekly-snapshots.json  # One entry per Mon–Sun week, 13 stores (Week view + WoW)
daily.json             # One entry per business day, 13 stores (Day + Month views)
notes.json             # Meeting notes state (prevNotes, consecutiveC tracker)
scripts/               # Scrapers (not deployed): weekly-update.js, daily-update.js, lib/verona.js, toast-daily-appsscript.gs
```

That's it. Intentionally simple — no build step, no framework, no dependencies. Pure static.

## The 13 stores (concepts → locations)

| Concept | Stores | POS |
|---|---|---|
| Ohgane (Korean BBQ) | Oakland, Concord, Alameda | Verona / Toast / Verona |
| Tangjip (Korean Hot Pot) | Hayward, Concord, Alameda | All Verona |
| Oh G Burger (K-Fusion) | Berkeley | Toast |
| Obento (Japanese) | Hayward | Toast |
| Hanshin Pocha (Bar) | Oakland | Clover (→ Toast ~2026-07) |
| Spoon (K-Bistro) | Berkeley | Verona |
| Bowl'd (K-Rice Bowl) | Albany | Verona |
| Golden Wang Donkatsu (K-Donkatsu) | Dublin | Verona |
| Jjamppong Zizon (Korean-Chinese) | Oakland (3905 Broadway) | Toast (added 07-06-2026, isNew) |

The `STORES` array in `index.html` (~line 450) is the single source of truth — sales, target, ratings, channel mix.

## Weekly automation (as of 2026-06-01)

Two jobs update the repo every Monday, split by what each platform can reach:

| Source | Stores | When | How |
|---|---|---|---|
| **Mac launchd** (`weekly-update.js --include-verona`) | Verona 8 + Hanshin 1 | Mon 7:30am PT | Verona: Playwright + programmatic V1 login (.env creds). Hanshin: Clover REST API (permanent token in .env) |
| **Cowork** task (`omc-weekly-monday-reminder`) | Toast 4 | Mon 8:02am PT | Claude-in-Chrome extension drives Dustin's real logged-in browser |

Why the split: Verona sessions expire fast and need programmatic .env login (only the Mac node script does that unattended); Hanshin's Clover is blocked from the Cowork sandbox; Toast needs a persistent browser session + device-trust (the Cowork Chrome extension). Both jobs `git pull --rebase --autostash` before pushing and each touches only its own stores' lines, so they merge cleanly regardless of run order.

**Coming ~2026-07:** Hanshin migrates Clover → Toast. Then add Hanshin as a 5th Toast store in the Cowork task and drop it from the Mac job (Mac → Verona only).

## dashboard.html — the at-a-glance page (added 09-30-2026)

`index.html` is the Monday **meeting tool** (notes, prime cost, PDF). `dashboard.html` is the **read-only overview**: 4 KPI tiles + one 13-row table (sales, % of target with meter, vs previous period, avg check, grade, 8-period sparkline), sortable, same Day/Week/Month toggle. Same GitHub Pages site: https://dhldustin-max.github.io/omc-weekly-live/dashboard.html. The two pages link to each other.

It has no data of its own: it fetches `index.html` and evals the `const STORES = [...]` block for names/targets (so targets live in one place), plus `weekly-snapshots.json` and `daily.json`. Grade = same formula as `calcGrade` minus the manager-entered prime-cost adjustment. Day target = weekly ÷ 7 (no weekday weighting — a Tuesday always looks weak); month target = daily × days that have data.

## Day / Week / Month views (added 09-30-2026)

Header toggle `Day | Week | Month` next to the picker. **Week** is unchanged (`weekly-snapshots.json`). **Day** and **Month** read `daily.json`:

```json
{ "days": { "2026-09-29": { "ohgane-concord": { "sales": 5579, "orders": 63, "guests": 150 }, "ohgane-oakland": { "sales": 4770 } } } }
```

Row fields (all optional except `sales`): `orders`, `guests`, `dineIn`/`takeout`/`delivery` ($ by channel), `labor` ($, Toast only — Toast's labor % × net), `discount` and `alcohol` ($, Verona only; alcohol = departments matching `ALCOHOL_RE` in `lib/verona.js` — dept names differ per store, extend the regex if a store's liquor dept is missed). `scripts/verona-parse.test.mjs` checks the parser against a saved page.

Month = sum of that month's days (pill shows `23/30 days` while partial). Targets/floor/stretch are weekly (rent-based) so the view scales them: day = ÷7, month = ×days-in-month÷7. Nothing else in the app changed — grades, bands, prime cost all read the scaled `STORES` values.

Who writes `daily.json`:

| Source | Stores | How | When |
|---|---|---|---|
| `scripts/daily-update.js` | Verona 7 | same `lib/verona.js`, one day per scrape (`--from/--to` to backfill, `--no-push`, `--dry-run`) | GitHub Actions `daily-verona.yml`, 13:00 UTC daily |
| `scripts/toast-daily-appsscript.gs` | Toast 6 | Google Apps Script in donghyuk@chimmelierusa.com reads the "OMC Hospitality - <day>" group email and PUTs `daily.json` via the GitHub contents API | daily trigger 7–8am PT (setup steps in the file header) |

dashboard.html shows Labor % and Delivery % for every period by summing the daily rows the period covers (so Week works too). Weekday heatmap = avg sales per weekday over the 28 days ending at the selected period.

Toast daily numbers are Toast's morning snapshot (voids after send not reflected) — fine for Day/Month, but **Week still comes from the Monday task's weekly-mail method**. Verona daily rows are sales only (no orders/guests), so Verona cards show `—` for orders in Day/Month.

## Weekly workflow (Monday 8am)

1. Last week's POS sales scraped (Toast for 4 stores, Verona for 8, Hanshin via Clover API)
2. Google + Yelp ratings refreshed (slow-changing — can skip most weeks)
3. `STORES` array in `index.html` updated with new sales numbers
4. `notes.json`: `weekEnding` updated, `newNotes` from last week → `prevNotes`, `consecutiveC` recomputed (reset on A/B, +1 on C)
5. Week tag updated (e.g., "Week of Apr 20 – 26, 2026")
6. `git commit && git push` → GitHub Pages rebuilds in ~30-60s

The Cowork scheduled task (`omc-weekly-monday-reminder`) scrapes **Toast (4 stores)** Monday 8:02am via the Claude-in-Chrome extension and pushes. Verona (8) + Hanshin (1) are done by the Mac launchd job at 7:30am. See the Weekly automation table above.

## Key features (what's implemented)

- **A/B/C grade** per store (weighted: 40% sales/target + 25% sales WoW + 15% sales/guest + 20% Google + Prime Cost penalty if >65%)
- **"⚠️ Needs Attention" badge** under Grade-C stores (escalates to "🚨 X weeks at C" if `consecutiveC >= 2`)
- **Concept average comparison** — "Your check $119 vs Ohgane avg $124"
- **Single-store focus mode** — picker to drill into one store for 1:1 manager meetings (hides other stores, shows prev/next nav)
- **Meeting notes with recap + checkboxes** — last week's notes show as checkboxes in "Last Week's Notes" section, this week's notes go into "This Week's Notes" via Add button
- **📤 Upload to Drive button** — downloads `OMC-meeting-YYYY-MM-DD.md` + opens Google Drive folder URL (https://drive.google.com/drive/u/2/folders/1HSQgATPvvsoL4izEOUac7tI3QU7E3TQ0) for manual drag-drop upload
- **Print + Copy + Download .md** also available

## What's pending (from previous task list)

- Concept-level PDF report (7 PDFs, one per concept) — task #46
- Store-level manager 1:1 PDFs (11 PDFs) — task #47
- Separate Chimmelier/Jilli group report (4 stores) — task #50
- Live web app workflow test with delegated employee — task #52

## Common operations you'll be asked to do

### Update last week's sales (typical Monday work)

Edit `STORES` array in `index.html`. Each store entry has `sales: <number>` — that's the gross net sales (excludes tax, includes service charges) for the week. Verona reports it as "SALES" in TOTALS section. Toast reports it as "Net sales" in Revenue Summary. Round to whole dollars.

Also update:
- `<div class="week-tag">📅 Week of MMM DD – DD, YYYY</div>` near top
- Comment `// === DATA (snapshot from MMM DD-DD scrape, generated YYYY-MM-DD) ===`
- `**Week:** MMM DD–DD, YYYY` inside the buildMessage template
- `notes.json`: `lastUpdated`, `weekEnding`, roll over notes if any

### Roll over meeting notes

When the user types notes in the live app and uploads the .md file, those become "this week's notes". The next Monday they should become "last week's notes" in `notes.json` under `prevNotes[storeId]`. Schema:

```json
{
  "prevNotes": {
    "ohgane-oakland": [
      {"id": "n-1", "text": "Banchan inventory issue", "week": "2026-04-19"}
    ]
  },
  "consecutiveC": {
    "ohgane-oakland": 0
  }
}
```

If a store was graded C this week, increment its `consecutiveC` by 1. If A/B, reset to 0. The web app uses this to show escalation banner ("🚨 X weeks at C — GM intervention needed") when `>= 2`.

### Add a new feature

Just edit `index.html` directly. CSS is in `<style>`, logic in `<script>`. The render functions key off `STORES` data — calling `recalcAll()` re-renders everything. Most state is in module-scope vars (PRIME_INPUTS, NOTES, currentFocus etc).

### Deploy

```bash
git add -A
git commit -m "Weekly update: Apr DD-DD"
git push
```

GitHub Pages rebuilds automatically. Wait 30-60s, then hard-refresh (Cmd+Shift+R).

## Architecture decisions worth knowing

- **Single file** — intentional. Easy for non-engineer (Dustin) to understand "the app is one file." No build pipeline. No npm. If you find yourself wanting to add a build step, push back.
- **No backend** — pure static. Notes typed in the app are in-memory only; the user uploads the .md file to Drive themselves. Persistence happens via the weekly Monday update where Claude (running this repo via Claude Code) commits the previous week's typed notes into `notes.json`.
- **GitHub Pages from main** — no separate `gh-pages` branch. Just push to main.
- **Korean UI** — help banner at top is in Korean. Manager labels mixed Korean/English. The store names use English. Don't translate help banner unless asked.

## Tone with Dustin

He's Korean-American restaurant operator, not a developer. Speaks mixed Korean+English. Prefers concise responses and concrete actions (link to commit, screenshot, etc.). Doesn't want long preambles. When he says "do X", just do X — confirm only what's irreversible (deletes, force pushes, etc.).

## Helpful commands

```bash
# Check current state
git log --oneline -10
git status

# View deployed site
open https://dhldustin-max.github.io/omc-weekly-live/

# Find the STORES array
grep -n "const STORES" index.html

# Check Korean encoding of file (should not show mojibake)
head -c 5000 index.html | grep -E "어떻게|미팅"
```

## Recent history (most recent first)

- `88acc1ce` Restore: Apr 20-26 sales (rebuilt from clean baseline) — current good state
- `bb093de7` Add prevSales + WoW % display under Net Sales
- `632441a6` Weekly update: Apr 20-26 sales (had encoding bug, replaced)
- `9cbffe59` Fix encoding + Drive URL /u/2/ for second account — last clean baseline
- `d87cf3a0` Add Upload to Drive + A/B/C grade + Needs Attention + Concept compare
- `05644bd6` Add meeting notes feature with recap + checkboxes

## Important: Cowork-side state to know about

These live in Cowork (not in this repo) but you should know they exist:

- **Scheduled task** `omc-weekly-monday-reminder` — fires every Monday 8am, scrapes POS data via Chrome MCP, then would commit to this repo. If something on the schedule breaks, the user fixes it from Cowork.
- **GitHub PAT** for pushing — stored as Cowork secret, not in this repo. In Claude Code, you'll use the user's normal git credentials (SSH or `gh auth`).
- **Drive folder** for meeting .md uploads — manual drag-drop after each Monday meeting.

---

**Last context handoff:** 2026-04-27. Switching from Cowork to Claude Code for repo development; keeping Cowork for Monday auto-scrape. See last commit `88acc1ce` for reference state.
