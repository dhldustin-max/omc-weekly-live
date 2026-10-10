// node scripts/toast-appsscript.test.mjs
// Runs the real syncToastDaily() from toast-daily-appsscript.gs against two saved Toast mails
// (HTML-only, like Gmail gives Apps Script) with Gmail / GitHub / Utilities mocked.
import fs from 'fs';
import assert from 'assert';
import vm from 'vm';

const fx = f => fs.readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8');
const msg = (subject, isoDate, html) => ({ getSubject: () => subject, getDate: () => new Date(isoDate), getBody: () => html,
  getPlainBody: () => { throw new Error('Toast mails have no plain-text part; parse getBody()'); } });
const daily = msg('OMC Hospitality - Tuesday, September 29', '2026-09-30T13:14:40Z', fx('toast-daily-2026-09-29.html'));
// A single-location nightly mail (real JZ Oakland 10/8 body, Chez Maeju subject) for SINGLE stores.
const single = msg('Chez Maeju - 6200 Claremont Avenue - Thursday, October 8', '2026-10-09T15:46:34Z', fx('toast-single-jzoak-2026-10-08.html'));
const weekly = msg('TUUM Korean Gastro Pub - 4869 Telegraph Avenue - Week of Sep 21–27', '2026-09-29T14:14:39Z', fx('toast-weekly-tuum-2026-09-21.html'));

const start = { days: { '2026-09-21': { 'tuum-oakland': { sales: 1, orders: 6 } } } };   // stale TUUM row to be corrected
let put = null; const logs = [];
const ctx = {
  GmailApp: { search: q => /Claremont/.test(q) ? [{ getMessages: () => [single] }] : /Week of/.test(q) ? [{ getMessages: () => [weekly] }] : [{ getMessages: () => [daily] }] },
  Logger: { log: s => logs.push(s) },
  Session: { getScriptTimeZone: () => 'America/Los_Angeles', getActiveUser: () => ({ getEmail: () => 'test@example.com' }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'TEST_TOKEN' }) },
  Utilities: {
    formatDate: (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d),
    base64Decode: s => Buffer.from(s, 'base64'),
    base64Encode: s => Buffer.from(s, 'utf8').toString('base64'),
    newBlob: b => ({ getDataAsString: () => Buffer.from(b).toString('utf8') }),
    Charset: { UTF_8: 'UTF-8' },
  },
  UrlFetchApp: { fetch: (url, o = {}) => {
    if ((o.method || 'get') === 'get') return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ sha: 'abc', content: Buffer.from(JSON.stringify(start)).toString('base64') }) };
    put = JSON.parse(o.payload); return { getResponseCode: () => 200, getContentText: () => '{}' };
  } },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('./toast-daily-appsscript.gs', import.meta.url), 'utf8'), ctx);
ctx.syncToastDaily();

assert(put, 'expected a GitHub PUT; log: ' + logs.join(' / '));
const out = JSON.parse(Buffer.from(put.content, 'base64').toString('utf8')).days;
// daily group mail, 9/29: all six Toast stores with sales/orders/guests/channel/labor
assert.deepStrictEqual(Object.keys(out['2026-09-29']).sort(), ['golden-wang-donkatsu-dublin','jjamppong-zizon-oakland','obento-hayward','oh-g-burger-berkeley','ohgane-concord','tuum-oakland']);
assert.deepStrictEqual(out['2026-09-29']['ohgane-concord'], { sales: 5579, orders: 63, guests: 150, takeout: 283, delivery: 0, dineIn: 5296, labor: 1774 });
assert.deepStrictEqual(out['2026-09-29']['golden-wang-donkatsu-dublin'], { sales: 1211, orders: 21, guests: 3, takeout: 145, delivery: 0, dineIn: 1066, labor: 788 });
// weekly mail: TUUM 9/21-27 sales/guests/labor corrected, orders kept from the existing row
assert.deepStrictEqual(out['2026-09-21']['tuum-oakland'], { sales: 261, orders: 6, guests: 5, labor: 393 });
assert.equal(out['2026-09-27']['tuum-oakland'].sales, 122);
assert.equal(Object.keys(out).filter(d => out[d]['tuum-oakland']).length, 8);   // 9/21..9/27 + 9/29
console.log('apps script end-to-end ok ·', logs.join(' / '));
// single-location mail -> its own row, same fields as the group mail
assert.deepStrictEqual(out['2026-10-08']['chez-maeju-oakland'], { sales: 736, orders: 23, guests: 10, labor: 629, dineIn: 414, delivery: 171, takeout: 151 });
console.log('single-location mail ok');
