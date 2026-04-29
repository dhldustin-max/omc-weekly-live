# Task: Update store targets based on rent analysis (3-tier system)

## Context

Dustin provided rough monthly rent for all 11 OMC stores. We did a rent-ratio analysis (rent ÷ monthly sales) and identified that some stores have unhealthy rent ratios (>10%), and the current targets in `STORES` don't reflect this. We need to update targets and add Floor/Stretch tiers.

**Industry benchmark:** Restaurants should aim for rent ratio 6-8% (healthy), with 10% as the upper bound before profitability risk.

## Rent data (monthly, USD)

```
Ohgane Oakland       $33,000
Ohgane Concord       $23,000
Ohgane Alameda       $36,000
Tangjip Alameda      $16,000
Tangjip Hayward       $9,000
Tangjip Concord      $11,000
Bowl'd Albany         $7,000
Oh G Burger Berkeley  $8,100
Hanshin Pocha        $11,000
Spoon Berkeley        $7,000
Obento Hayward        $2,000
```

## Strategy: 3-tier system per store (weekly numbers)

For each store, we add three target levels driven by rent ratio:

```
Floor   = (Rent_monthly / 0.10) / 4.33    # 10% rent — minimum to stay profitable
Target  = max(                             # the displayed/operational target
            (Rent_monthly / 0.08) / 4.33,  #   rent-based: 8% (healthy)
            current_target                  #   never lower an existing achievable target
          )
Stretch = (Rent_monthly / 0.06) / 4.33    # 6% rent — A-grade aspiration
```

**Why `max()` for Target:** Some cash-cow stores (Tangjip Hayward, Bowl'd Albany) already exceed their rent-based 8% target. Lowering their target would be silly. We only RAISE targets where rent-reality demands it.

## Per-store updates to `STORES` array in `index.html`

For each store, update the `target` field and ADD two new fields: `floor` and `stretch`.

| Store | Floor (10%) | **Target** | Stretch (6%) | Change |
|---|---|---|---|---|
| ohgane-oakland | 76,212 | **95,266** | 127,021 | ↑ from 69,369 |
| ohgane-concord | 53,118 | 75,519 | 88,531 | unchanged (current already healthy) |
| ohgane-alameda | 83,140 | **103,927** | 138,569 | ↑ from 64,833 |
| tangjip-hayward | 20,785 | 47,635 | 34,642 | unchanged (cash cow) |
| tangjip-concord | 25,404 | 35,573 | 42,341 | unchanged |
| tangjip-alameda | 36,952 | **46,189** | 61,587 | ↑ from 25,021 |
| bowld-albany | 16,166 | 30,026 | 26,944 | unchanged (overperforming rent) |
| oh-g-burger-berkeley | 18,706 | **23,383** | 31,177 | ↑ from 11,537 |
| obento-hayward | 4,619 | 9,859 | 7,698 | unchanged |
| hanshin-pocha-oakland | 25,404 | **31,755** | 42,341 | ↑ from 20,000 |
| spoon-berkeley | 16,166 | **20,208** | 26,944 | ↑ from 17,881 |

(Numbers are integers, rounded.)

### Concrete edits

In `index.html`, find the `STORES = [` array (~line 450) and update each entry:

```js
{ id: "ohgane-oakland", ...,
  sales: 67616, target: 95266, floor: 76212, stretch: 127021,
  rent: 33000, ...},
{ id: "ohgane-concord", ...,
  sales: 74778, target: 75519, floor: 53118, stretch: 88531,
  rent: 23000, ...},
{ id: "ohgane-alameda", ...,
  sales: 65043, target: 103927, floor: 83140, stretch: 138569,
  rent: 36000, ...},
{ id: "tangjip-hayward", ...,
  sales: 44554, target: 47635, floor: 20785, stretch: 34642,
  rent: 9000, ...},
{ id: "tangjip-concord", ...,
  sales: 34123, target: 35573, floor: 25404, stretch: 42341,
  rent: 11000, ...},
{ id: "tangjip-alameda", ...,
  sales: 22100, target: 46189, floor: 36952, stretch: 61587,
  rent: 16000, ...},
{ id: "bowld-albany", ...,
  sales: 27194, target: 30026, floor: 16166, stretch: 26944,
  rent: 7000, ...},
{ id: "oh-g-burger-berkeley", ...,
  sales: 6434, target: 23383, floor: 18706, stretch: 31177,
  rent: 8100, ...},
{ id: "obento-hayward", ...,
  sales: 6839, target: 9859, floor: 4619, stretch: 7698,
  rent: 2000, ...},
{ id: "hanshin-pocha-oakland", ...,
  sales: null, target: 31755, floor: 25404, stretch: 42341,
  rent: 11000, ...},
{ id: "spoon-berkeley", ...,
  sales: 15028, target: 20208, floor: 16166, stretch: 26944,
  rent: 7000, ...},
```

## UI enhancement: 3-tier display

In each store card, replace the single "vs Target" line with a 3-tier indicator showing where current sales falls (Floor / Target / Stretch).

### Suggested visual

```
┌─────────────────────────────────────────────────────┐
│  Net Sales                                          │
│  $67,616  (last week $66,065, +2.3% WoW)            │
│                                                      │
│  Floor   ─────────●────── Target  ─── Stretch       │
│  $76K    you here          $95K              $127K  │
│                                                      │
│  Rent ratio: 11.3% (Goal: ≤8%)                      │
└─────────────────────────────────────────────────────┘
```

### Implementation hints

1. Add a `.tier-bar` CSS class — horizontal flex with 3 markers (floor, target, stretch) and a position indicator showing where `sales` falls relative to them.
2. Color: red if sales < floor, yellow if floor ≤ sales < target, green if sales ≥ target.
3. Compute rent ratio on the fly: `(rent / (sales × 4.33)) × 100` → display with one decimal.
4. The `calcGrade()` function should still work — sales/target ratio drives A/B/C — but consider reweighting:
   - If `sales >= stretch`: A
   - If `sales >= target`: B
   - Else: C
   (This is more aggressive than the current weighted formula. Discuss with Dustin before changing — the existing weighted formula incorporates Google rating + Prime Cost which is valuable.)

## Stores needing immediate attention (call out in UI)

These have rent ratio > 10% — they need a "🚨 Rent stress" badge added next to the existing Needs Attention badge:

- **Oh G Burger Berkeley** — 29% rent ratio (critical)
- **Tangjip Alameda** — 16.7% rent ratio (critical)
- **Ohgane Alameda** — 12.8% rent ratio (warning, large absolute rent)
- **Ohgane Oakland** — 11.3% rent ratio (warning)
- **Spoon Berkeley** — 10.8% rent ratio (borderline)

Suggested badge logic:

```js
function rentRatio(s) {
  if (!s.sales || !s.rent) return null;
  return (s.rent / (s.sales * 4.33)) * 100;
}
function rentStressLabel(s) {
  const r = rentRatio(s);
  if (r === null) return null;
  if (r >= 12) return "🚨 Rent stress (" + r.toFixed(1) + "%)";
  if (r >= 10) return "⚠️ Rent tight (" + r.toFixed(1) + "%)";
  return null;
}
```

Show under the store header, alongside the existing `needs-attention` badge.

## Hanshin Pocha caveat

Hanshin Pocha has `sales: null` (no POS API access — Clover system). The new target of $31,755/week is a rent-based estimate. **Action item:** ask Dustin to manually pull a recent week's sales from Clover so we can validate this target.

## Verification checklist

After implementing:

- [ ] All 11 stores have `target`, `floor`, `stretch`, `rent` fields populated
- [ ] `floor < target ≤ stretch` for every store (math sanity)
- [ ] Web app renders without JS errors
- [ ] Rent ratio displays correctly (cross-check Ohgane Oakland: 33000 / (67616 * 4.33) ≈ 11.3%)
- [ ] Cash-cow stores (Tangjip Hayward, Bowl'd Albany) still show as A-grade
- [ ] Stress stores (Oh G Burger, Tangjip Alameda) show new "Rent stress" badge
- [ ] Single-store focus mode still works
- [ ] Notes section unchanged
- [ ] Upload to Drive button still works

## Commit message

```
Add 3-tier targets (Floor/Target/Stretch) based on rent ratio

- Target = max(rent/8%, current target) — never lower achievable bars
- Floor = rent/10% (minimum profitability)
- Stretch = rent/6% (A-grade aspiration)
- Add rent stress badge for stores with rent ratio > 10%
- 5 stores get raised targets: Ohgane Oakland/Alameda, Tangjip Alameda,
  Oh G Burger, Hanshin Pocha, Spoon Berkeley
```

## Discuss with Dustin if uncertain

- The Target jumps for Ohgane Oakland ($69K → $95K) and Ohgane Alameda ($65K → $104K) are aggressive. These stores are physically at their capacity ceiling — hitting 8% rent might be impossible. Confirm with Dustin whether we should:
  - (a) Cap Target at capacity-based ceiling instead of pure rent ratio
  - (b) Mark them as "structurally over-rented" and renegotiate lease at next renewal
- Tangjip Alameda jumping from $25K → $46K is doubling the bar. That's demoralizing if unrealistic. Discuss: is this a 12-month goal, not weekly?
- Oh G Burger jumping from $11.5K → $23K may be unfair for a new store still ramping up. Consider keeping new-store targets on a separate "ramp curve" until 12 months in.
