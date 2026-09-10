// Runs the real BillRoom message handlers with isolated in-memory storage.
// No running server, external requests, payment apps, or real payments.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { BillRoom } from "../src/worker.js";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const money = vm.createContext({});
vm.runInContext(readFileSync(new URL("../public/money.js", import.meta.url), "utf8"), money);
const totals = (bill) => Object.fromEntries(money.computeTotals(bill).perPerson.map((row) => [row.person.id, row.totalCents]));
const marks = { pA: 101, pB: 102, pC: 103 };

function fixture(overrides = {}) {
  let stored = {
    restaurant: "Dinner", items: [{ id: "iShared", name: "Shared dish", qty: 1, priceCents: 1200 }, { id: "iSolo", name: "Solo dish", qty: 1, priceCents: 900 }],
    taxCents: 0, tip: { mode: "percent", value: 0 },
    people: ["A", "B", "C"].map((name) => ({ id: "p" + name, name, color: "#333", tokenHash: hash("token-" + name) })),
    claims: { iShared: { pA: 1, pB: 1 }, iSolo: { pC: 1 } }, paid: { ...marks }, pay: {}, locked: false,
    creatorTokenHash: hash("creator-token"), version: 1, lastActivity: Date.now(),
    ...structuredClone(overrides),
  };
  const messages = [], alarms = [], closed = [];
  const socket = { send: (raw) => messages.push(JSON.parse(raw)), close: (...args) => closed.push(args) };
  const ctx = {
    getWebSockets: () => [socket],
    storage: {
      get: async () => structuredClone(stored),
      put: async (_, value) => { stored = structuredClone(value); },
      setAlarm: async (time) => { alarms.push(time); },
      deleteAll: async () => { stored = null; },
    },
  };
  const room = new BillRoom(ctx);
  const message = (value) => room.webSocketMessage(socket, JSON.stringify({ token: "creator-token", ...(value.type === "set_paid" && value.paid ? { expectedVersion: stored.version } : {}), ...value }));
  const edit = (changes = {}) => message({ type: "edit_bill", bill: { restaurant: stored.restaurant, items: stored.items, taxCents: stored.taxCents, tip: stored.tip, ...changes } });
  const adminRemove = (personId) => room.fetch(new Request("https://do/remove-person", { method: "POST", body: JSON.stringify({ personId }) }));
  return { room, messages, alarms, closed, message, edit, adminRemove, bill: () => structuredClone(stored) };
}

test("changing a shared claim clears marks before broadcasting changed amounts", async () => {
  const f = fixture();
  const before = totals(f.bill());
  await f.message({ type: "set_claim", personId: "pA", itemId: "iShared", units: 0, token: "token-A" });
  assert.notDeepEqual(totals(f.bill()), before);
  assert.deepEqual(f.bill().paid, {}, "all marks are conservatively invalidated, including an unaffected person's mark");
  assert.deepEqual(f.messages.at(-1).bill.paid, {});
  assert.ok(Number.isInteger(f.bill().paidResetAt));
  assert.equal(f.messages.at(-1).bill.paidResetAt, f.bill().paidResetAt);
  await f.message({ type: "set_paid", personId: "pB", paid: true, token: "token-B" });
  assert.ok(f.bill().paid.pB, "the new amount can be marked paid again");
});

test("replayed, clamped and legacy no-op claims preserve paid marks and version", async () => {
  const f = fixture();
  for (const change of [{ units: 1 }, { units: 9 }, { claimed: true }]) {
    await f.message({ type: "set_claim", personId: "pA", itemId: "iShared", token: "token-A", ...change });
    assert.deepEqual(f.bill().paid, marks);
    assert.equal(f.bill().version, 1);
  }
  await f.message({ type: "set_claim", personId: "pA", itemId: "iSolo", units: 0, token: "token-A" });
  assert.deepEqual(f.bill().paid, marks);
  assert.equal(f.bill().version, 1);
});

for (const kind of ["price", "quantity", "tax", "tip", "deleted item"]) test("financial edit clears paid marks: " + kind, async () => {
  const f = fixture();
  const bill = f.bill();
  const changed = kind === "price" ? { items: bill.items.map((item) => ({ ...item, priceCents: item.priceCents + 100 })) }
    : kind === "quantity" ? { items: bill.items.map((item) => ({ ...item, qty: 3 })) }
    : kind === "tax" ? { taxCents: 211 }
    : kind === "tip" ? { tip: { mode: "amount", value: 315 } }
    : { items: [bill.items[0]] };
  await f.edit(changed);
  assert.notDeepEqual(totals(f.bill()), totals(bill));
  assert.deepEqual(f.bill().paid, {});
});

test("cosmetic edits, item reordering and an equivalent tip preserve paid marks", async () => {
  const f = fixture();
  const before = totals(f.bill());
  await f.edit();
  await f.edit({ restaurant: "Dinner renamed", items: f.bill().items.map((item) => ({ ...item, name: item.name + " renamed" })).reverse(), tip: { mode: "amount", value: 0 } });
  await f.message({ type: "rename_person", personId: "pA", name: "Alice" });
  await f.message({ type: "set_pay", pay: { venmo: "dinnerhost" } });
  await f.message({ type: "lock", locked: true });
  assert.deepEqual(totals(f.bill()), before);
  assert.deepEqual(f.bill().paid, marks);
});

test("rejected financial mutations preserve paid marks", async () => {
  const f = fixture();
  await f.message({ type: "set_claim", personId: "pA", itemId: "iShared", units: 0, token: "token-B" });
  await f.message({ type: "set_claim", personId: "pA", itemId: "iShared", units: -1 });
  await f.message({ type: "edit_bill", bill: { items: [] } });
  assert.deepEqual(f.bill().paid, marks);
  assert.equal(f.bill().version, 1);
});

test("removing a shared claimant invalidates other participants' changed totals", async () => {
  const f = fixture();
  await f.message({ type: "remove_person", personId: "pB", token: "token-B" });
  assert.equal(totals(f.bill()).pA, 1200);
  assert.deepEqual(f.bill().paid, {});
  const version = f.bill().version;
  await f.message({ type: "remove_person", personId: "pB" });
  assert.equal(f.bill().version, version, "repeated removal remains a no-op");
});

test("admin removal uses the same settlement invalidation", async () => {
  const f = fixture();
  assert.equal((await f.adminRemove("pB")).status, 200);
  assert.equal(totals(f.bill()).pA, 1200);
  assert.deepEqual(f.bill().paid, {});
});

test("ordinary nonclaiming guest joins and removals preserve existing marks", async () => {
  const f = fixture();
  const before = totals(f.bill());
  await f.message({ type: "join", name: "Guest", token: undefined });
  const guest = f.bill().people.at(-1).id;
  assert.equal(totals(f.bill())[guest], 0);
  assert.deepEqual(f.bill().paid, marks);
  await f.message({ type: "set_paid", personId: guest, paid: true });
  await f.message({ type: "remove_person", personId: guest });
  assert.deepEqual(totals(f.bill()), before);
  assert.deepEqual(f.bill().paid, marks);
});

const freeItemBill = { items: [{ id: "iFree", name: "Complimentary", qty: 1, priceCents: 0 }], claims: { iFree: { pA: 1, pB: 1, pC: 1 } }, taxCents: 300, tip: { mode: "amount", value: 300 } };
test("joining a zero-price bill redistributes fees and clears paid marks", async () => {
  const f = fixture(freeItemBill);
  assert.equal(totals(f.bill()).pA, 200);
  await f.message({ type: "join", name: "Guest", token: undefined });
  assert.equal(totals(f.bill()).pA, 150);
  assert.deepEqual(f.bill().paid, {});
});

test("removing even a nonclaimant from a zero-price bill invalidates redistributed fees", async () => {
  const f = fixture({ ...freeItemBill, claims: { iFree: { pA: 1 } } });
  await f.adminRemove("pC");
  assert.equal(totals(f.bill()).pA, 300);
  assert.deepEqual(f.bill().paid, {});
});

test("a changed restaurant payer invalidates old settlement assumptions", async () => {
  const f = fixture({ creatorPersonId: "pA" });
  await f.message({ type: "join", name: "New payer" });
  assert.notEqual(f.bill().creatorPersonId, "pA");
  assert.deepEqual(f.bill().paid, {});
});

test("legacy array claims still invalidate settlement when their allocation changes", async () => {
  const f = fixture({ claims: { iShared: ["pA", "pB"], iSolo: ["pC"] } });
  await f.message({ type: "set_claim", personId: "pA", itemId: "iShared", units: 0 });
  assert.equal(totals(f.bill()).pB, 1200);
  assert.deepEqual(f.bill().paid, {});
});

// Delay real token verification to reproduce the old gap between reading a
// stored bill and writing it back after another message had already changed it.
async function duringDelayedTokenCheck(action) {
  const original = crypto.subtle.digest;
  let entered, release, delayed = false;
  const ready = new Promise((resolve) => { entered = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  crypto.subtle.digest = async function (...args) {
    if (!delayed) { delayed = true; entered(); await wait; }
    return original.apply(this, args);
  };
  try { await action({ ready, release }); }
  finally { release(); crypto.subtle.digest = original; }
}

test("concurrent paid and claim messages cannot restore a stale financial snapshot", async () => {
  const f = fixture({ paid: {} });
  await duringDelayedTokenCheck(async ({ ready, release }) => {
    const paid = f.message({ type: "set_paid", personId: "pB", paid: true });
    await ready;
    const claim = f.message({ type: "set_claim", personId: "pA", itemId: "iShared", units: 0 });
    release();
    await Promise.all([paid, claim]);
  });
  assert.deepEqual(f.bill().claims.iShared, { pB: 1 });
  assert.equal(totals(f.bill()).pB, 1200);
  assert.deepEqual(f.bill().paid, {});
  assert.equal(f.bill().version, 3, "both ordered mutations were saved");
});

test("admin removal waits for in-flight messages and cannot be overwritten", async () => {
  const f = fixture({ paid: {} });
  await duringDelayedTokenCheck(async ({ ready, release }) => {
    const paid = f.message({ type: "set_paid", personId: "pA", paid: true });
    await ready;
    const removal = f.adminRemove("pB");
    release();
    const [, response] = await Promise.all([paid, removal]);
    assert.equal(response.status, 200);
  });
  assert.equal(f.bill().people.some((person) => person.id === "pB"), false);
  assert.equal(totals(f.bill()).pA, 1200);
  assert.deepEqual(f.bill().paid, {});
});

test("an old rendered paid request arriving after a claim change is rejected", async () => {
  const f = fixture();
  const expectedVersion = f.bill().version;
  await f.message({ type: "set_claim", personId: "pA", itemId: "iShared", units: 0 });
  const currentVersion = f.bill().version;
  await f.message({ type: "set_paid", personId: "pB", paid: true, expectedVersion });
  assert.match(f.messages.at(-1).message, /review the latest totals/i);
  assert.equal(f.bill().version, currentVersion);
  assert.deepEqual(f.bill().paid, {});
  await f.message({ type: "set_paid", personId: "pB", paid: true, expectedVersion: currentVersion });
  assert.ok(f.bill().paid.pB);
});

test("missing, noninteger and future paid versions fail closed; undo needs none", async () => {
  const f = fixture({ paid: {} });
  for (const expectedVersion of [undefined, null, "1", 1.5, 0, 999]) {
    await f.message({ type: "set_paid", personId: "pA", paid: true, expectedVersion });
    assert.equal(f.messages.at(-1).type, "error");
    assert.deepEqual(f.bill().paid, {});
    assert.equal(f.bill().version, 1);
  }
  await f.message({ type: "set_paid", personId: "pA", paid: true, expectedVersion: 1 });
  assert.ok(f.bill().paid.pA);
  await f.message({ type: "set_paid", personId: "pA", paid: false });
  assert.deepEqual(f.bill().paid, {});
  assert.equal(f.bill().paidResetAt, undefined, "manual undo isn't a financial reset");
});

test("only invalidating true paid marks advances the persisted reset timestamp", async () => {
  const f = fixture();
  await f.edit({ taxCents: 100 });
  const reset = f.bill().paidResetAt;
  assert.ok(Number.isInteger(reset));
  await f.edit({ taxCents: 200 });
  assert.equal(f.bill().paidResetAt, reset, "further edits without marks don't invent another reset");
  await f.message({ type: "set_paid", personId: "pA", paid: true });
  await f.edit({ restaurant: "New name" });
  assert.equal(f.bill().paidResetAt, reset);
  await f.edit({ taxCents: 300 });
  assert.ok(f.bill().paidResetAt > reset);
  const read = await f.room.fetch(new Request("https://do/state"));
  assert.equal((await read.json()).bill.paidResetAt, f.bill().paidResetAt, "state reads retain the explanation for a reload");
  const noTrueMarks = fixture({ paid: { pA: false, pB: 0 } });
  await noTrueMarks.edit({ taxCents: 100 });
  assert.equal(noTrueMarks.bill().paidResetAt, undefined);
});

test("an identical successful paid request can be replayed without changing state", async () => {
  const f = fixture({ paid: {} });
  const request = { type: "set_paid", personId: "pA", paid: true, expectedVersion: 1 };
  await f.message(request);
  const saved = f.bill();
  const count = f.messages.length;
  await f.message(request);
  assert.deepEqual(f.bill(), saved);
  assert.equal(f.messages.length, count, "the same payload is a silent no-op, not a stale-view error");
  await f.message({ ...request, expectedVersion: undefined });
  assert.equal(f.messages.at(-1).type, "error", "an existing mark doesn't waive version validation for old clients");
});

test("an alarm queued behind new activity reschedules instead of deleting the bill", async () => {
  const f = fixture({ lastActivity: Date.now() - 91 * 86400_000 });
  await duringDelayedTokenCheck(async ({ ready, release }) => {
    const change = f.message({ type: "set_claim", personId: "pA", itemId: "iShared", units: 0 });
    await ready;
    const alarm = f.room.alarm();
    release();
    await Promise.all([change, alarm]);
  });
  assert.ok(f.bill(), "newly active bill survives its already-dispatched alarm");
  assert.equal(f.bill().claims.iShared.pA, undefined);
  assert.equal(f.closed.length, 0);
  assert.equal(f.alarms.at(-1), f.bill().lastActivity + 90 * 86400_000);
});

test("an actually inactive bill expires and closes its sockets", async () => {
  const f = fixture({ lastActivity: Date.now() - 91 * 86400_000 });
  await f.room.alarm();
  assert.equal(f.bill(), null);
  assert.deepEqual(f.closed, [[1000, "expired"]]);
  assert.equal(f.alarms.length, 0);
});

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name, error.message); }
}
console.log(`${tests.length - failed}/${tests.length} settlement tests passed`);
process.exitCode = failed ? 1 : 0;
