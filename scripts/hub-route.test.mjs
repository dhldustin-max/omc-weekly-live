// node scripts/hub-route.test.mjs — who may open what on the hub.
import assert from "assert";
import { route } from "../hub/route.js";
import { onlyStores } from "../hub/lib.js";
const H = "https://omc-hub.pages.dev", M = ["ohgane-alameda"];
assert.equal(route("*", H + "/"), "/dashboard");
assert.equal(route("*", H + "/meeting"), null);
assert.equal(route("*", H + "/labor.html"), null);
assert.equal(route(M, H + "/"), "/store?id=ohgane-alameda");
assert.equal(route(M, H + "/store?id=ohgane-alameda"), null);
assert.equal(route(M, H + "/store.html?id=ohgane-alameda"), null);
assert.equal(route(M, H + "/store?id=ohgane-oakland"), "/store?id=ohgane-alameda");   // other store
assert.equal(route(M, H + "/store"), "/store?id=ohgane-alameda");
for (const p of ["/dashboard", "/labor", "/meeting", "/index.html", "/daily.json"]) assert.equal(route(M, H + p), "/store?id=ohgane-alameda", p);
assert.equal(route(M, H + "/payroll"), null);
assert.equal(route(M, H + "/marketing"), null);
assert.equal(route(M, H + "/weekly"), null);
assert.equal(route(M, H + "/plan"), null);
assert.equal(route(M, H + "/api/data/daily.json"), null);   // the API itself filters to M
// a redirect target is always allowed for that user (no loops)
for (const s of ["*", M]) { const t = route(s, H + "/"); assert.equal(route(s, H + t), null); }
// data a manager receives holds only their stores
const daily = { days: { "2026-10-01": { "ohgane-alameda": { sales: 1 }, "ohgane-oakland": { sales: 2 } } } };
assert.deepEqual(Object.keys(onlyStores("daily.json", daily, M).days["2026-10-01"]), ["ohgane-alameda"]);
assert.deepEqual(Object.keys(onlyStores("payroll.json", { periods: { p: { stores: { "ohgane-oakland": {}, "ohgane-alameda": {} } } } }, M).periods.p.stores), ["ohgane-alameda"]);
assert.equal(onlyStores("notes.json", {}, M), null);   // corporate-only files
console.log("hub route + filters ok");
