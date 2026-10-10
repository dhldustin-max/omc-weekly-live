// node scripts/sched.test.mjs — schedule hour parsing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
new Function(readFileSync(new URL("../sched.js", import.meta.url), "utf8"))();
const h = globalThis.hoursOf;
assert.equal(h("10-9"), 11);
assert.equal(h("10-2, 5-9"), 8);
assert.equal(h("10:30-3"), 4.5);
assert.equal(h("4-10"), 6);
assert.equal(h("11am-2pm"), 3);
assert.equal(h("5pm-1am"), 8);
assert.equal(h("O-C", "10:30", "21:30"), 11);
assert.equal(h("4-close", "10:30", "21:30"), 5.5);
assert.equal(h("O-C"), null);          // store hours not set yet
assert.equal(h("off"), null);
assert.equal(h(""), null);
console.log("sched ok");
