// node scripts/verona-parse.test.mjs — parser check against a saved Verona SUMMARY page
import fs from 'fs';
import assert from 'assert';
import { parseSummaryText, sumHours } from './lib/verona.js';
const p = parseSummaryText(fs.readFileSync(new URL('../tmp/verona-summary-2026-04-29T00-19-01.txt', import.meta.url), 'utf8'));
assert.equal(p.sales, 44553.96);
assert.equal(p.orders, 559);
assert.equal(p.guests, 655);
assert.equal(p.discount, 5);
assert.equal(Math.round(p.channel.dineIn * 100), 3744670);
assert.equal(Math.round(p.channel.delivery * 100), 517308);                       // ORIGINATIONS 3RD PARTY
assert.equal(Math.round(p.channel.takeout * 100), 4454896 - 3744670 - 517308);     // rest of DESTINATIONS
// Bowl'd tags app orders as DRIVE-THRU; delivery must still come out of ORIGINATIONS
if (fs.existsSync(new URL('../tmp/verona-BOWLD_ALBANY.txt', import.meta.url))) {
  const b = parseSummaryText(fs.readFileSync(new URL('../tmp/verona-BOWLD_ALBANY.txt', import.meta.url), 'utf8'));
  assert.equal(Math.round(b.channel.delivery), 1303);
}
assert.equal(Math.round(p.alcohol * 100), 104602);
console.log('verona parser ok', p);
assert.equal(sumHours('VIEW ALL\nALEX\n7.52 h\nANNY\n12.68 h\nSECURITY GUARD\n11.17 h\nMenu'), 31.37);
assert.equal(sumHours('no hours'), null);
