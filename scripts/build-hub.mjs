// Builds the OMC hub (Cloudflare Pages) into dist/:
//   • the dashboard pages + assets as-is (data.js reroutes their data fetches to /api on the hub);
//   • payroll.html = the payroll Apps Script page (../omc-payroll/Index.html) with its google.script.run
//     calls swapped for POST /api/payroll;
//   • hub/stores.json = STORES from index.html, for /api/stores.
// Data files (*.json) are NOT copied — the API reads them from GitHub and filters them per user.
// Usage: node scripts/build-hub.mjs && npx wrangler pages deploy dist --project-name omc-hub
import fs from "fs";
import assert from "assert";

const ROOT = new URL("..", import.meta.url).pathname;
const FILES = ["dashboard.html", "store.html", "labor.html", "index.html", "nav.js", "chart.js", "data.js", "omc-logo.png"];
fs.rmSync(ROOT + "dist", { recursive: true, force: true });
fs.mkdirSync(ROOT + "dist");
FILES.forEach(f => fs.copyFileSync(ROOT + f, ROOT + "dist/" + f));

const html = fs.readFileSync(ROOT + "index.html", "utf8");
const stores = new Function("return " + html.match(/const STORES = (\[[\s\S]*?\n  \]);/)[1])();
fs.writeFileSync(ROOT + "hub/stores.json", JSON.stringify(stores));

let pay = fs.readFileSync(ROOT + "../omc-payroll/Index.html", "utf8");
const swap = (from, to) => { assert(pay.includes(from), "payroll page changed: " + from.slice(0, 50)); pay = pay.replace(from, to); };
swap(`var KEY = "<?= key ?>";`, `var KEY = "hub", STORE = new URLSearchParams(location.search).get("store");`);
swap(`function call(fn) {
  var args = [].slice.call(arguments, 1);
  return new Promise(function (ok, bad) { google.script.run.withSuccessHandler(ok).withFailureHandler(bad)[fn].apply(null, args); });
}`, `// Hub: the same actions go to /api/payroll, which checks this user's stores (args[0] was the link key).
function call(fn) {
  var args = [].slice.call(arguments, 2);
  return fetch("/api/payroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn: fn, store: STORE, args: args }) })
    .then(function (r) { return r.json(); }).then(function (j) { if (!j.ok) throw new Error(j.error); return j.result; });
}`);
swap(`\nstart('');`, `
// Hub: managers open their store; corporate gets the office view unless ?store= is given.
(STORE ? Promise.resolve() : fetch("/api/me").then(function (r) { return r.json(); }).then(function (me) { STORE = me.stores === "*" ? "*office" : me.stores[0]; }))
  .then(function () { start(""); }).catch(fail);`);
swap(`<meta charset="utf-8">`, `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OMC Payroll</title><script src="data.js"></script>`);
swap(`</body>`, `<script src="nav.js"></script>\n</body>`);
fs.writeFileSync(ROOT + "dist/payroll.html", pay);
console.log("dist:", fs.readdirSync(ROOT + "dist").join(", "), "| stores:", stores.length);
