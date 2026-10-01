/**
 * Toast daily group email -> daily.json (OMC weekly-live repo). Google Apps Script.
 *
 * Runs inside the Gmail account that receives "OMC Hospitality - <Weekday>, <Month D>"
 * (donghyuk@chimmelierusa.com). No server, no Chrome, no Cowork.
 *
 * One-time setup (5 min):
 *   1. script.google.com (logged in as donghyuk@chimmelierusa.com) -> New project -> paste this file.
 *   2. Project Settings -> Script properties -> add GITHUB_TOKEN = a fine-grained PAT with
 *      Contents: Read and write on dhldustin-max/omc-weekly-live (nothing else).
 *   3. Run `syncToastDaily` once by hand (grants Gmail + UrlFetch permission), check the log.
 *   4. Triggers -> Add trigger -> syncToastDaily, Time-driven, Day timer, 7am-8am (Pacific).
 *      Toast sends the mail ~6:15am PT; the trigger reads the last 3 days so a miss self-heals.
 *
 * Numbers are the morning snapshot Toast puts in the mail (voids after send are not reflected).
 * Sales, guests and labor are overwritten from the weekly mails once they arrive (voids and
 * clock-outs corrected), so week totals built from these daily rows match the weekly mail.
 * Week totals still come from weekly-snapshots.json - this only feeds Day / Month views.
 */
var REPO = 'dhldustin-max/omc-weekly-live';
var FILE = 'daily.json';
var STORES = {                     // Location column -> store id (same table as the Monday task)
  '1671 Willow Pass Road': 'ohgane-concord',
  '1823 Solano Avenue': 'oh-g-burger-berkeley',
  '22521 Main Street': 'obento-hayward',
  '3905 Broadway': 'jjamppong-zizon-oakland',
  '7222 Regional Street': 'golden-wang-donkatsu-dublin',
  '4869 Telegraph Avenue': 'tuum-oakland'
};
var LOOKBACK_DAYS = 3;

function syncToastDaily() {
  var threads = GmailApp.search('from:no-reply@toasttab.com subject:"OMC Hospitality" newer_than:' + (LOOKBACK_DAYS + 1) + 'd');
  var parsed = {}, seen = 0;
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      var day = parseDay_(m.getSubject(), m.getDate());
      if (!day) return;
      seen++;
      var rows = parseStores_(htmlToPipeText_(m.getBody()));   // Toast mails are HTML-only
      if (Object.keys(rows).length) parsed[day] = rows;
    });
  });
  // Weekly mails ("<store> - <address> - Week of Sep 20-26") carry corrected per-day labor %
  // (the daily mail goes out before managers fix auto clock-outs). They override daily labor.
  var laborFix = {};  // day -> id -> labor $
  GmailApp.search('from:no-reply@toasttab.com subject:"Week of" newer_than:10d').forEach(function (t) {
    t.getMessages().forEach(function (m) {
      var id = null;
      Object.keys(STORES).forEach(function (addr) { if (m.getSubject().indexOf(addr) >= 0) id = STORES[addr]; });
      if (!id) return;
      seen++;
      parseWeeklyLabor_(htmlToPipeText_(m.getBody()), m.getDate()).forEach(function (r) {
        (laborFix[r.day] = laborFix[r.day] || {})[id] = { sales: r.sales, guests: r.guests, labor: r.labor };
        (parsed[r.day] = parsed[r.day] || {});
      });
    });
  });
  if (!Object.keys(parsed).length) {
    Logger.log(seen ? 'found ' + seen + ' Toast mails but could not read their tables (layout changed?)'
                    : 'no Toast mails found in ' + Session.getActiveUser().getEmail() + ' (wrong account?)');
    return;
  }

  var gh = getFile_();
  var db = JSON.parse(gh.content);
  db.days = db.days || {};
  var changed = 0;
  Object.keys(parsed).forEach(function (day) {
    db.days[day] = db.days[day] || {};
    Object.keys(laborFix[day] || {}).forEach(function (id) {
      // A weekly-mail day creates the row even without a daily mail (orders then stay empty).
      var fix = laborFix[day][id], v = { sales: fix.sales, guests: fix.guests };
      if (fix.labor != null) v.labor = fix.labor;
      parsed[day][id] = Object.assign({}, parsed[day][id] || {}, v);
    });
    Object.keys(parsed[day]).forEach(function (id) {
      var v = parsed[day][id], old = db.days[day][id];
      if (old && JSON.stringify(old) === JSON.stringify(Object.assign({}, old, v))) return;
      db.days[day][id] = Object.assign(old || {}, v); changed++;
    });
  });
  if (!changed) { Logger.log('daily.json already up to date for ' + Object.keys(parsed).join(', ')); return; }
  var sorted = {};
  Object.keys(db.days).sort().forEach(function (k) { sorted[k] = db.days[k]; });
  db.days = sorted;
  putFile_(JSON.stringify(db, null, 2) + '\n', gh.sha, 'daily: Toast ' + Object.keys(parsed).sort().join(', ') + ' (Apps Script)');
  Logger.log('pushed ' + changed + ' values for ' + Object.keys(parsed).join(', '));
}

// "OMC Hospitality - Sunday, September 27" -> 2026-09-27 (year from the mail's date; Jan mail about Dec 31 handled)
function parseDay_(subject, sent) {
  var m = subject.match(/-\s*\w+,\s*(\w+)\s+(\d{1,2})\s*$/);
  if (!m) return null;
  var year = sent.getFullYear();
  var d = new Date(m[1] + ' ' + m[2] + ', ' + year);
  if (d > sent) d.setFullYear(year - 1);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');  // d was built in the script's own zone
}

// Toast mails are HTML-only. Flatten every innermost <tr> into "| cell | cell |" so the table
// parsers below can read them. Toast leaves some <td> unclosed, so a cell also ends at the next cell.
function htmlToPipeText_(html) {
  var dec = function (s) {
    return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#36;|&dollar;/g, '$')
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); }).replace(/\s+/g, ' ').trim();
  };
  var lines = [], tr = /<tr\b[^>]*>((?:(?!<tr\b)[\s\S])*?)<\/tr>/gi, m;
  while ((m = tr.exec(html))) {
    var cells = [], td = /<t[dh]\b[^>]*>([\s\S]*?)(?=<\/t[dh]>|<t[dh]\b|$)/gi, c;
    while ((c = td.exec(m[1]))) cells.push(dec(c[1]));
    if (cells.join('')) lines.push('| ' + cells.join(' | ') + ' |');
  }
  return lines.join('\n');
}

// Three per-location tables in the mail, keyed by their header row:
//   Order Type  | Location | # of Takeout Orders | Total Takeout Sales | # of Delivery Orders | Total Delivery Sales | # of Dine-In Orders | Total Dine-In Sales |
//   Breakdown   | Location | Total (Gross) Sales | Labor (% of Net) | Discount (% of Gross) | Refund Total |
//   Totals      | Location | Total Sales | # of Orders | Avg Sales/Order | # of Guests | Avg Sales/Guest | Qty Void Items |
function parseStores_(text) {
  var money = function (s) { return Number(String(s).replace(/[$,%]/g, '')); };
  var tables = [];
  var lines = text.split('\n'), cur = null;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (/^\|\s*Location\s*\|/.test(l)) { cur = { head: l, rows: {} }; tables.push(cur); continue; }
    if (!cur) continue;
    if (!/^\|/.test(l)) { cur = null; continue; }
    var c = l.split('|').map(function (s) { return s.trim(); });
    if (STORES[c[1]]) cur.rows[STORES[c[1]]] = c;
  }
  var find = function (re) { for (var t = 0; t < tables.length; t++) if (re.test(tables[t].head)) return tables[t].rows; return {}; };
  var tot = find(/Total Sales\s*\|\s*# of Orders/), typ = find(/Total Takeout Sales/), brk = find(/Labor \(% of Net\)/);
  var out = {};
  Object.keys(tot).forEach(function (id) {
    var c = tot[id], sales = Math.round(money(c[2]));
    var v = { sales: sales, orders: Number(c[3]), guests: Number(c[5]) };
    if (typ[id]) { v.takeout = Math.round(money(typ[id][3])); v.delivery = Math.round(money(typ[id][5])); v.dineIn = Math.round(money(typ[id][7])); }
    if (brk[id]) v.labor = Math.round(sales * money(brk[id][3]) / 100);
    out[id] = v;
  });
  return out;
}

// "| Sun 09/20 | $14,278.50 | 345 | $126.36 | 19.4% |" -> [{ day: '2026-09-20', labor: 2770 }]; closed days ("-") skipped.
function parseWeeklyLabor_(text, sent) {
  var out = [], on = false, lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (/^\|\s*Day\s*\|\s*Net sales\s*\|.*Hourly labor cost %/.test(l)) { on = true; continue; }
    if (!on) continue;
    if (/^\|---/.test(l)) continue;
    if (!/^\|/.test(l)) break;
    var c = l.split('|').map(function (s) { return s.trim(); });
    var md = c[1].match(/(\d{2})\/(\d{2})/), pct = parseFloat(c[5]);
    if (!md) { if (out.length) break; continue; }   // end of the Daily breakdown table
    var y = sent.getFullYear(); if (Number(md[1]) > sent.getMonth() + 1) y--;   // Dec week mailed in Jan
    var net = Number(c[2].replace(/[$,]/g, ''));
    out.push({ day: y + '-' + md[1] + '-' + md[2], sales: Math.round(net), guests: Number(c[3]) || 0,
               labor: isNaN(pct) ? null : Math.round(net * pct / 100) });   // closed day: '-' labor -> null
  }
  return out;
}

function ghHeaders_() {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('Set GITHUB_TOKEN in Project Settings -> Script properties');
  return { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
}
function getFile_() {
  var r = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + '/contents/' + FILE, { headers: ghHeaders_(), muteHttpExceptions: true });
  if (r.getResponseCode() === 404) return { sha: null, content: '{"days":{}}' };
  if (r.getResponseCode() !== 200) throw new Error('GitHub GET ' + r.getResponseCode() + ': ' + r.getContentText());
  var j = JSON.parse(r.getContentText());
  return { sha: j.sha, content: Utilities.newBlob(Utilities.base64Decode(j.content)).getDataAsString('UTF-8') };
}
function putFile_(content, sha, message) {
  var body = { message: message, content: Utilities.base64Encode(content, Utilities.Charset.UTF_8), branch: 'main' };
  if (sha) body.sha = sha;
  var r = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + '/contents/' + FILE, {
    method: 'put', contentType: 'application/json', headers: ghHeaders_(), payload: JSON.stringify(body), muteHttpExceptions: true });
  if (r.getResponseCode() >= 300) throw new Error('GitHub PUT ' + r.getResponseCode() + ': ' + r.getContentText());
}
