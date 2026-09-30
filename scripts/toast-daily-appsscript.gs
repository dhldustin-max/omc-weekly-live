/**
 * Toast daily group email → daily.json (OMC weekly-live repo). Google Apps Script.
 *
 * Runs inside the Gmail account that receives "OMC Hospitality - <Weekday>, <Month D>"
 * (donghyuk@chimmelierusa.com). No server, no Chrome, no Cowork.
 *
 * One-time setup (5 min):
 *   1. script.google.com (logged in as donghyuk@chimmelierusa.com) → New project → paste this file.
 *   2. Project Settings → Script properties → add GITHUB_TOKEN = a fine-grained PAT with
 *      Contents: Read and write on dhldustin-max/omc-weekly-live (nothing else).
 *   3. Run `syncToastDaily` once by hand (grants Gmail + UrlFetch permission), check the log.
 *   4. Triggers → Add trigger → syncToastDaily, Time-driven, Day timer, 7am–8am (Pacific).
 *      Toast sends the mail ~6:15am PT; the trigger reads the last 3 days so a miss self-heals.
 *
 * Numbers are the morning snapshot Toast puts in the mail (voids after send are not reflected).
 * Week totals still come from weekly-snapshots.json — this only feeds Day / Month views.
 */
var REPO = 'dhldustin-max/omc-weekly-live';
var FILE = 'daily.json';
var STORES = {                     // Location column → store id (same table as the Monday task)
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
  var parsed = {};
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      var day = parseDay_(m.getSubject(), m.getDate());
      if (!day) return;
      var rows = parseStores_(m.getPlainBody());
      if (Object.keys(rows).length) parsed[day] = rows;
    });
  });
  if (!Object.keys(parsed).length) { Logger.log('no Toast daily mails found'); return; }

  var gh = getFile_();
  var db = JSON.parse(gh.content);
  db.days = db.days || {};
  var changed = 0;
  Object.keys(parsed).forEach(function (day) {
    db.days[day] = db.days[day] || {};
    Object.keys(parsed[day]).forEach(function (id) {
      var v = parsed[day][id], old = db.days[day][id];
      if (old && old.sales === v.sales && old.orders === v.orders && old.guests === v.guests) return;
      db.days[day][id] = v; changed++;
    });
  });
  if (!changed) { Logger.log('daily.json already up to date for ' + Object.keys(parsed).join(', ')); return; }
  var sorted = {};
  Object.keys(db.days).sort().forEach(function (k) { sorted[k] = db.days[k]; });
  db.days = sorted;
  putFile_(JSON.stringify(db, null, 2) + '\n', gh.sha, 'daily: Toast ' + Object.keys(parsed).sort().join(', ') + ' (Apps Script)');
  Logger.log('pushed ' + changed + ' values for ' + Object.keys(parsed).join(', '));
}

// "OMC Hospitality - Sunday, September 27" → 2026-09-27 (year from the mail's date; Jan mail about Dec 31 handled)
function parseDay_(subject, sent) {
  var m = subject.match(/-\s*\w+,\s*(\w+)\s+(\d{1,2})\s*$/);
  if (!m) return null;
  var year = sent.getFullYear();
  var d = new Date(m[1] + ' ' + m[2] + ', ' + year);
  if (d > sent) d.setFullYear(year - 1);
  return Utilities.formatDate(d, 'America/Los_Angeles', 'yyyy-MM-dd');
}

// The "| Location | Total Sales | # of Orders | Avg Sales/Order | # of Guests | ..." table
function parseStores_(text) {
  var out = {};
  var lines = text.split('\n');
  var inTable = false;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (/^\|\s*Location\s*\|\s*Total Sales\s*\|/.test(l)) { inTable = true; continue; }
    if (!inTable) continue;
    if (!/^\|/.test(l)) break;
    var c = l.split('|').map(function (s) { return s.trim(); });
    var id = STORES[c[1]];
    if (!id) continue;
    out[id] = { sales: Math.round(Number(c[2].replace(/[$,]/g, ''))), orders: Number(c[3]), guests: Number(c[5]) };
  }
  return out;
}

function ghHeaders_() {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('Set GITHUB_TOKEN in Project Settings → Script properties');
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
