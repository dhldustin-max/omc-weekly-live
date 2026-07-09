# OMC Hospitality Weekly Ops — Project Context

## What this is

A live web app at **https://dhldustin-max.github.io/omc-weekly-live/** used by Dustin (Director) to run weekly Monday manager meetings across 13 OMC Hospitality restaurants in the Bay Area.

The app shows Sales vs Target, Prime Cost calculation, A/B/C grade, manager meeting notes, and concept-level comparisons. Updates weekly with last week's POS data.

**Repo:** https://github.com/dhldustin-max/omc-weekly-live (deployed via GitHub Pages from `main` branch)

## File structure

```
index.html          # Single-file web app (HTML + CSS + JS in one file)
notes.json          # Meeting notes state (prevNotes, consecutiveC tracker)
README.md           # Optional, brief
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
| Mad For Sushi (Sushi) | Dublin | Verona |
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
