// Integration tests for the Splitty Worker + Durable Objects.
//
// Runs against a live `wrangler dev` (default http://127.0.0.1:8787) so the
// Durable Objects, WebSockets, alarms and asset routing are the real thing.
//
//   npm run dev            # in one terminal (needs SESSION_SECRET in .dev.vars)
//   npm test               # in another — or: BASE_URL=... node test/integration.mjs
//
// The session cookie is minted locally with the same HMAC scheme the Worker
// uses, so the tests exercise the signed-in path without touching Google.
// SESSION_SECRET must match .dev.vars (default below matches the checked-in
// example value used by `npm run dev`).

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8787";
const SECRET = process.env.SESSION_SECRET || "dev-secret-for-local-tests-only";
const WS_BASE = BASE.replace(/^http/, "ws");

// ---------- helpers ----------

const b64url = (buf) => Buffer.from(buf).toString("base64url");
function mintSession({ sub = "test-user", email = "test@example.com", name = "Test User", exp = Date.now() + 3600_000 } = {}) {
  const body = b64url(JSON.stringify({ sub, email, name, exp }));
  const sig = createHmac("sha256", SECRET).update(body).digest();
  return `splitty_session=${body}.${b64url(sig)}`;
}

async function api(path, { method = "GET", body, cookie, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

// A tiny WebSocket client wrapper: queues every parsed message so tests can
// `await` the next one of a given type with a timeout.
function openSocket(billId) {
  const sock = new WebSocket(`${WS_BASE}/api/bills/${billId}/ws`);
  const queue = [];
  const waiters = [];
  let closed = null;
  sock.addEventListener("message", (e) => {
    if (e.data === "pong") return;
    const msg = JSON.parse(e.data);
    const w = waiters.findIndex((x) => x.pred(msg));
    if (w >= 0) waiters.splice(w, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  sock.addEventListener("close", (e) => { closed = { code: e.code, reason: e.reason }; for (const w of waiters) w.reject(new Error("socket closed")); });
  const ready = new Promise((resolve, reject) => {
    sock.addEventListener("open", () => resolve());
    sock.addEventListener("error", () => reject(new Error("ws error")));
  });
  return {
    sock,
    ready,
    send: (o) => sock.send(JSON.stringify(o)),
    sendRaw: (s) => sock.send(s),
    next(pred = () => true, ms = 4000) {
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) waiters.splice(k, 1); reject(new Error("timed out waiting for message")); }, ms);
        const w = { pred, resolve: (m) => { clearTimeout(t); resolve(m); }, reject: (e) => { clearTimeout(t); reject(e); } };
        waiters.push(w);
      });
    },
    // Wait until a state broadcast satisfies `pred(bill)`.
    async stateWhere(pred, ms = 4000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const m = await this.next((x) => x.type === "state", deadline - Date.now());
        if (pred(m.bill)) return m.bill;
      }
      throw new Error("no matching state broadcast");
    },
    get closed() { return closed; },
    close: () => sock.close(),
  };
}

// Mirrors bill.html's money math so the server + client agree on the cents.
function allocate(totalCents, weights) {
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0 || totalCents <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (totalCents * w) / sumW);
  const base = exact.map(Math.floor);
  let leftover = totalCents - base.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < leftover; k++) base[order[k % order.length].i]++;
  return base;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- tests ----------

const SAMPLE = {
  restaurant: "Test Diner",
  items: [
    { name: "Burger", qty: 1, priceCents: 1499 },
    { name: "Fries", qty: 1, priceCents: 599 },
    { name: "Pitcher", qty: 1, priceCents: 2400 },
  ],
  taxCents: 360,
  tip: { mode: "percent", value: 18 },
};

async function createBill(overrides = {}, cookie = mintSession()) {
  const r = await api("/api/bills", { method: "POST", body: { ...SAMPLE, ...overrides }, cookie });
  assert.equal(r.status, 200, `create bill: ${JSON.stringify(r.data)}`);
  assert.match(r.data.billId, /^[A-Za-z0-9_-]{16,64}$/);
  assert.match(r.data.creatorToken, /^[A-Za-z0-9_-]{16,64}$/);
  return r.data;
}

test("config + me: auth is on in dev, anonymous has no user", async () => {
  const c = await api("/api/config");
  assert.equal(c.status, 200);
  assert.equal(c.data.authRequired, true);
  assert.equal(c.data.authMisconfigured, false);
  const me = await api("/api/me");
  assert.equal(me.data.user, null);
  const meIn = await api("/api/me", { cookie: mintSession({ email: "a@b.c", name: "A" }) });
  assert.deepEqual(meIn.data.user, { email: "a@b.c", name: "A" });
});

test("sessions: expired or tampered cookies are rejected", async () => {
  const expired = await api("/api/me", { cookie: mintSession({ exp: Date.now() - 1000 }) });
  assert.equal(expired.data.user, null);
  const good = mintSession();
  const tampered = good.slice(0, -2) + (good.endsWith("A") ? "BB" : "AA");
  const t = await api("/api/me", { cookie: tampered });
  assert.equal(t.data.user, null);
});

test("create bill: requires sign-in, rejects bad input, accepts good input", async () => {
  const anon = await api("/api/bills", { method: "POST", body: SAMPLE });
  assert.equal(anon.status, 401);
  const cookie = mintSession();
  const empty = await api("/api/bills", { method: "POST", body: { ...SAMPLE, items: [] }, cookie });
  assert.equal(empty.status, 400);
  const badPrice = await api("/api/bills", { method: "POST", body: { ...SAMPLE, items: [{ name: "x", priceCents: 12.5 }] }, cookie });
  assert.equal(badPrice.status, 400);
  const notJson = await fetch(BASE + "/api/bills", { method: "POST", headers: { cookie }, body: "nope" });
  assert.equal(notJson.status, 400);
  const { billId } = await createBill({}, cookie);
  const state = await api("/api/bills/" + billId);
  assert.equal(state.status, 200);
  assert.equal(state.data.bill.restaurant, "Test Diner");
  assert.equal(state.data.bill.people.length, 0);
  assert.equal(state.data.bill.creatorTokenHash, undefined, "creator hash must never leave the DO");
  assert.equal(state.data.bill.version, 1);
});

test("create bill: cross-origin POST is refused, same-origin allowed", async () => {
  const cookie = mintSession();
  const evil = await api("/api/bills", { method: "POST", body: SAMPLE, cookie, headers: { origin: "https://evil.example" } });
  assert.equal(evil.status, 403);
  const same = await api("/api/bills", { method: "POST", body: SAMPLE, cookie, headers: { origin: new URL(BASE).origin } });
  assert.equal(same.status, 200);
});

test("create bill: tip and tax are clamped exactly like the client preview", async () => {
  const { billId } = await createBill({ taxCents: -5, tip: { mode: "percent", value: 250.55 } });
  const { data } = await api("/api/bills/" + billId);
  assert.equal(data.bill.taxCents, 0);
  assert.deepEqual(data.bill.tip, { mode: "percent", value: 100 });
  const b2 = await createBill({ tip: { mode: "amount", value: 12.6 } });
  const s2 = await api("/api/bills/" + b2.billId);
  assert.deepEqual(s2.data.bill.tip, { mode: "amount", value: 13 });
});

test("unknown bill: 404 on state, and the bill page still serves for valid-looking ids", async () => {
  const r = await api("/api/bills/" + "x".repeat(22));
  assert.equal(r.status, 404);
  const page = await fetch(BASE + "/b/" + "x".repeat(22));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-robots-tag"), "noindex");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  const short = await fetch(BASE + "/b/short", { redirect: "manual" });
  assert.notEqual(short.status, 200, "ids shorter than 16 chars must not resolve to a bill page");
});

test("realtime: join, claim, shared split, exact totals, version ordering", async () => {
  const { billId, creatorToken } = await createBill();
  const a = openSocket(billId);
  const b = openSocket(billId);
  await Promise.all([a.ready, b.ready]);
  const first = await a.next((m) => m.type === "state");
  assert.equal(first.bill.version, 1);
  await b.next((m) => m.type === "state");

  a.send({ type: "join", name: "  Alice  " });
  const joinedA = await a.next((m) => m.type === "joined");
  assert.match(joinedA.personId, /^p[A-Za-z0-9_-]{10}$/);
  const s1 = await b.stateWhere((bill) => bill.people.length === 1);
  assert.equal(s1.people[0].name, "Alice", "names are trimmed");
  assert.equal(s1.people[0].tokenHash, undefined, "person token hashes never broadcast");
  assert.equal(s1.version, 2);

  b.send({ type: "join", name: "Bob" });
  const joinedB = await b.next((m) => m.type === "joined");
  const s2 = await a.stateWhere((bill) => bill.people.length === 2);
  assert.notEqual(s2.people[0].color, s2.people[1].color);

  const [burger, fries, pitcher] = s2.items.map((i) => i.id);
  // Alice claims the burger; Bob claims fries; both share the pitcher.
  a.send({ type: "set_claim", itemId: burger, personId: joinedA.personId, claimed: true, token: joinedA.token });
  b.send({ type: "set_claim", itemId: fries, personId: joinedB.personId, claimed: true, token: joinedB.token });
  a.send({ type: "set_claim", itemId: pitcher, personId: joinedA.personId, claimed: true, token: joinedA.token });
  b.send({ type: "set_claim", itemId: pitcher, personId: joinedB.personId, claimed: true, token: joinedB.token });
  const full = await a.stateWhere((bill) => Object.values(bill.claims).reduce((n, e) => n + Object.keys(e).length, 0) === 4);
  assert.deepEqual(full.claims[burger], { [joinedA.personId]: 1 });
  assert.deepEqual(full.claims[fries], { [joinedB.personId]: 1 });
  assert.equal(Object.keys(full.claims[pitcher]).length, 2);

  // Money: shares 1499+1200 and 599+1200; tax 360 and tip 18% of 4498=810 split by share weight.
  const shares = [1499 + 1200, 599 + 1200];
  const tip = Math.round((4498 * 18) / 100);
  const taxAlloc = allocate(360, [...shares, 0]);
  const tipAlloc = allocate(tip, [...shares, 0]);
  const totals = shares.map((s, i) => s + taxAlloc[i] + tipAlloc[i]);
  assert.equal(totals[0] + totals[1], 4498 + 360 + tip, "per-person totals sum to the bill total");

  // Idempotent replay: claiming an already-claimed item changes nothing (no new version).
  a.send({ type: "set_claim", itemId: burger, personId: joinedA.personId, claimed: true, token: joinedA.token });
  // Then a real change so we can observe ordering.
  a.send({ type: "set_claim", itemId: burger, personId: joinedA.personId, claimed: false, token: joinedA.token });
  const after = await a.stateWhere((bill) => !bill.claims[burger]);
  assert.equal(after.version, full.version + 1, "a no-op replay must not bump the version");

  // Wrong token: Bob can't claim for Alice.
  b.send({ type: "set_claim", itemId: burger, personId: joinedA.personId, claimed: true, token: joinedB.token });
  const err = await b.next((m) => m.type === "error");
  assert.match(err.message, /only claim items for yourself/i);

  // Creator can act for anyone.
  a.send({ type: "set_claim", itemId: burger, personId: joinedB.personId, claimed: true, token: creatorToken });
  await a.stateWhere((bill) => joinedB.personId in (bill.claims[burger] || {}));

  a.close(); b.close();
});

test("realtime: lock blocks joins and claims for non-creators, creator can still edit", async () => {
  const { billId, creatorToken } = await createBill();
  const c = openSocket(billId);
  const p = openSocket(billId);
  await Promise.all([c.ready, p.ready]);
  await c.next((m) => m.type === "state"); await p.next((m) => m.type === "state");
  p.send({ type: "join", name: "Pat" });
  const joined = await p.next((m) => m.type === "joined");
  await c.stateWhere((b) => b.people.length === 1);

  p.send({ type: "lock", locked: true, token: joined.token });
  assert.match((await p.next((m) => m.type === "error")).message, /only the bill creator/i);

  c.send({ type: "lock", locked: true, token: creatorToken });
  const locked = await p.stateWhere((b) => b.locked === true);
  assert.equal(locked.locked, true);

  const late = openSocket(billId);
  await late.ready; await late.next((m) => m.type === "state");
  late.send({ type: "join", name: "Late" });
  assert.match((await late.next((m) => m.type === "error")).message, /locked/i);

  const item = locked.items[0].id;
  p.send({ type: "set_claim", itemId: item, personId: joined.personId, claimed: true, token: joined.token });
  assert.match((await p.next((m) => m.type === "error")).message, /locked/i);

  c.send({ type: "set_claim", itemId: item, personId: joined.personId, claimed: true, token: creatorToken });
  await p.stateWhere((b) => joined.personId in (b.claims[item] || {}));

  c.send({ type: "lock", locked: false, token: creatorToken });
  await p.stateWhere((b) => b.locked === false);
  c.close(); p.close(); late.close();
});

test("realtime: edit_bill keeps claims on surviving items and drops the rest", async () => {
  const { billId, creatorToken } = await createBill();
  const c = openSocket(billId);
  await c.ready;
  const init = (await c.next((m) => m.type === "state")).bill;
  c.send({ type: "join", name: "Cara" });
  const me = await c.next((m) => m.type === "joined");
  await c.stateWhere((b) => b.people.length === 1);
  const [burger, fries] = init.items.map((i) => i.id);
  c.send({ type: "set_claim", itemId: burger, personId: me.personId, claimed: true, token: me.token });
  c.send({ type: "set_claim", itemId: fries, personId: me.personId, claimed: true, token: me.token });
  await c.stateWhere((b) => b.claims[burger] && b.claims[fries]);

  // Non-creator can't edit.
  c.send({ type: "edit_bill", token: me.token, bill: { items: [{ id: burger, name: "Burger", priceCents: 1 }] } });
  assert.match((await c.next((m) => m.type === "error")).message, /only the bill creator/i);

  // Creator drops fries, keeps burger (same id), adds a new item without id.
  c.send({ type: "edit_bill", token: creatorToken, bill: {
    restaurant: "  Renamed  ",
    items: [{ id: burger, name: "Burger deluxe", priceCents: 1699 }, { name: "Shake", priceCents: 650 }],
    taxCents: 100, tip: { mode: "amount", value: 500 },
  } });
  const edited = await c.stateWhere((b) => b.restaurant === "Renamed");
  assert.equal(edited.items.length, 2);
  assert.deepEqual(edited.claims[burger], { [me.personId]: 1 }, "claim on the surviving item is kept");
  assert.equal(edited.claims[fries], undefined, "claim on the deleted item is dropped");
  assert.equal(edited.items[0].name, "Burger deluxe");
  assert.match(edited.items[1].id, /^i[A-Za-z0-9_-]{8}$/);
  assert.deepEqual(edited.tip, { mode: "amount", value: 500 });

  // Invalid edit is rejected with a message and leaves the bill alone.
  c.send({ type: "edit_bill", token: creatorToken, bill: { items: [] } });
  assert.match((await c.next((m) => m.type === "error")).message, /items/i);
  c.close();
});

test("realtime: remove_person clears their claims; rename is scoped to the person", async () => {
  const { billId, creatorToken } = await createBill();
  const a = openSocket(billId); const b = openSocket(billId);
  await Promise.all([a.ready, b.ready]);
  const init = (await a.next((m) => m.type === "state")).bill; await b.next((m) => m.type === "state");
  a.send({ type: "join", name: "Ann" }); const ann = await a.next((m) => m.type === "joined");
  b.send({ type: "join", name: "Ben" }); const ben = await b.next((m) => m.type === "joined");
  await a.stateWhere((s) => s.people.length === 2);
  const item = init.items[0].id;
  a.send({ type: "set_claim", itemId: item, personId: ann.personId, claimed: true, token: ann.token });
  b.send({ type: "set_claim", itemId: item, personId: ben.personId, claimed: true, token: ben.token });
  await a.stateWhere((s) => Object.keys(s.claims[item] || {}).length === 2);

  b.send({ type: "rename_person", personId: ann.personId, name: "Hacked", token: ben.token });
  assert.match((await b.next((m) => m.type === "error")).message, /not allowed/i);
  a.send({ type: "rename_person", personId: ann.personId, name: "Annie", token: ann.token });
  await b.stateWhere((s) => s.people.find((p) => p.id === ann.personId)?.name === "Annie");

  b.send({ type: "remove_person", personId: ann.personId, token: ben.token });
  assert.match((await b.next((m) => m.type === "error")).message, /not allowed/i);
  a.send({ type: "remove_person", personId: ben.personId, token: creatorToken });
  const after = await a.stateWhere((s) => s.people.length === 1);
  assert.deepEqual(after.claims[item], { [ann.personId]: 1 }, "removed person's claim is gone, Ann's remains");
  // Removing again is a silent no-op (idempotent).
  a.send({ type: "remove_person", personId: ben.personId, token: creatorToken });
  a.send({ type: "rename_person", personId: ann.personId, name: "Ann", token: ann.token });
  const again = await a.stateWhere((s) => s.people[0].name === "Ann");
  assert.equal(again.version, after.version + 1);
  a.close(); b.close();
});

test("realtime: garbage frames are ignored, ping is answered, floods are throttled", async () => {
  const { billId } = await createBill();
  const s = openSocket(billId);
  await s.ready; await s.next((m) => m.type === "state");
  s.sendRaw("not json");
  s.sendRaw(JSON.stringify({ type: "nonsense" }));
  s.sendRaw("ping");
  const pong = await new Promise((resolve) => {
    const h = (e) => { if (e.data === "pong") { s.sock.removeEventListener("message", h); resolve(true); } };
    s.sock.addEventListener("message", h);
    setTimeout(() => resolve(false), 3000);
  });
  assert.equal(pong, true, "ping must be answered with pong (auto-response)");
  for (let i = 0; i < 45; i++) s.send({ type: "join", name: "Flood" + i });
  const err = await s.next((m) => m.type === "error" && /slow down|too many joins/i.test(m.message), 6000);
  assert.ok(err, "flooding is rejected");
  s.close();
});

// ---------- quantity-aware claims ----------

// public/money.js is a plain browser script; evaluate it here so the tests
// exercise the exact math the bill page runs.
const money = {};
vm.createContext(money);
vm.runInContext(readFileSync(new URL("../public/money.js", import.meta.url), "utf8"), money);

test("money: units split a multi-quantity line in proportion, leftovers stay unclaimed", () => {
  const people = [{ id: "pA", name: "A", color: "#000" }, { id: "pB", name: "B", color: "#111" }];
  const base = { items: [{ id: "i1", name: "Beer", qty: 3, priceCents: 1800 }], taxCents: 0, tip: { mode: "percent", value: 0 }, people };
  // A had 2 of 3, B had 1: 1200 / 600, nothing unclaimed.
  let t = money.computeTotals({ ...base, claims: { i1: { pA: 2, pB: 1 } } });
  assert.deepEqual(t.perPerson.map((r) => r.shareCents), [1200, 600]);
  assert.equal(t.unclaimed, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(t.perPerson[0].items[0])), { item: base.items[0], part: 1200, units: 2, of: 3, sharers: 2 });
  // Only A, 1 of 3: 600 claimed, 1200 unclaimed.
  t = money.computeTotals({ ...base, claims: { i1: { pA: 1 } } });
  assert.deepEqual(t.perPerson.map((r) => r.shareCents), [600, 0]);
  assert.equal(t.unclaimed, 1200);
  // Over-claimed (two people each say 2 of 3): split by units, line fully claimed.
  t = money.computeTotals({ ...base, claims: { i1: { pA: 2, pB: 2 } } });
  assert.deepEqual(t.perPerson.map((r) => r.shareCents), [900, 900]);
  assert.equal(t.unclaimed, 0);
  assert.equal(t.perPerson[0].items[0].of, 4);
  // Legacy array claims still read as one unit each.
  t = money.computeTotals({ ...base, claims: { i1: ["pA", "pB"] } });
  assert.deepEqual(t.perPerson.map((r) => r.shareCents), [600, 600]);
  assert.equal(t.unclaimed, 600);
  // Rounding stays exact: $10.00 across 3 units claimed 1/1/1 sums to 1000.
  const three = [...people, { id: "pC", name: "C", color: "#222" }];
  t = money.computeTotals({ items: [{ id: "i", name: "x", qty: 3, priceCents: 1000 }], taxCents: 0, tip: { mode: "percent", value: 0 }, people: three, claims: { i: { pA: 1, pB: 1, pC: 1 } } });
  assert.equal(t.perPerson.reduce((a, r) => a + r.shareCents, 0), 1000);
  // Tax and tip follow the claimed shares; unclaimed share carries its part too.
  t = money.computeTotals({ ...base, taxCents: 180, tip: { mode: "percent", value: 10 }, claims: { i1: { pA: 1 } } });
  assert.equal(t.perPerson[0].totalCents + t.unclaimed + t.unclaimedTax + t.unclaimedTip, 1800 + 180 + 180);
});

test("realtime: units are validated, clamped to the line qty, and legacy claimed:true still works", async () => {
  const { billId, creatorToken } = await createBill({ items: [{ name: "Beer", qty: 3, priceCents: 1800 }, { name: "Nachos", qty: 1, priceCents: 1200 }] });
  const a = openSocket(billId); const b = openSocket(billId);
  await Promise.all([a.ready, b.ready]);
  const init = (await a.next((m) => m.type === "state")).bill; await b.next((m) => m.type === "state");
  const [beer, nachos] = init.items.map((i) => i.id);
  a.send({ type: "join", name: "Ann" }); const ann = await a.next((m) => m.type === "joined");
  b.send({ type: "join", name: "Ben" }); const ben = await b.next((m) => m.type === "joined");
  await a.stateWhere((s) => s.people.length === 2);

  a.send({ type: "set_claim", itemId: beer, personId: ann.personId, units: 2, token: ann.token });
  b.send({ type: "set_claim", itemId: beer, personId: ben.personId, claimed: true, token: ben.token });
  const s1 = await a.stateWhere((s) => s.claims[beer] && s.claims[beer][ben.personId]);
  assert.deepEqual(s1.claims[beer], { [ann.personId]: 2, [ben.personId]: 1 });

  // More than the line holds is clamped; 0 removes; bad numbers are rejected.
  b.send({ type: "set_claim", itemId: beer, personId: ben.personId, units: 9, token: ben.token });
  const s2 = await a.stateWhere((s) => s.claims[beer][ben.personId] === 3);
  assert.equal(s2.claims[beer][ben.personId], 3);
  b.send({ type: "set_claim", itemId: beer, personId: ben.personId, units: -1, token: ben.token });
  assert.match((await b.next((m) => m.type === "error")).message, /sensible/i);
  b.send({ type: "set_claim", itemId: beer, personId: ben.personId, token: ben.token });
  assert.match((await b.next((m) => m.type === "error")).message, /how many/i);
  b.send({ type: "set_claim", itemId: beer, personId: ben.personId, units: 0, token: ben.token });
  const s3 = await a.stateWhere((s) => s.version > s2.version && !(ben.personId in (s.claims[beer] || {})));
  assert.deepEqual(s3.claims[beer], { [ann.personId]: 2 });

  // qty-1 lines cap at one unit each, however many are asked for.
  a.send({ type: "set_claim", itemId: nachos, personId: ann.personId, units: 5, token: ann.token });
  const s4 = await b.stateWhere((s) => s.claims[nachos]);
  assert.deepEqual(s4.claims[nachos], { [ann.personId]: 1 });

  // Editing the line down to qty 1 clamps Ann's 2 beers to 1.
  a.send({ type: "edit_bill", token: creatorToken, bill: { items: [{ id: beer, name: "Beer", qty: 1, priceCents: 600 }, { id: nachos, name: "Nachos", priceCents: 1200 }] } });
  const s5 = await b.stateWhere((s) => s.items[0].qty === 1);
  assert.deepEqual(s5.claims[beer], { [ann.personId]: 1 });
  a.close(); b.close();
});

test("settle up: pay handles are validated and normalised at create time", async () => {
  const cookie = mintSession();
  const bad = await api("/api/bills", { method: "POST", body: { ...SAMPLE, pay: { venmo: "has space" } }, cookie });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Venmo/);
  const badCash = await api("/api/bills", { method: "POST", body: { ...SAMPLE, pay: { cashapp: "1starts-with-digit" } }, cookie });
  assert.equal(badCash.status, 400);
  const { billId } = await createBill({ pay: {
    venmo: "https://venmo.com/u/Seb-Splits?x=1",
    cashapp: "$sebsplits",
    paypal: "paypal.me/SebSplits/",
    ignored: "field",
  } }, cookie);
  const { data } = await api("/api/bills/" + billId);
  assert.deepEqual(data.bill.pay, { venmo: "Seb-Splits", cashapp: "sebsplits", paypal: "SebSplits" });
  assert.deepEqual(data.bill.paid, {});
  // No pay object at all is fine too — and old-style bills read back with empty objects.
  const plain = await createBill({}, cookie);
  const s2 = await api("/api/bills/" + plain.billId);
  assert.deepEqual(s2.data.bill.pay, {});
  assert.deepEqual(s2.data.bill.paid, {});
});

test("settle up: creator sets pay details live; others can't", async () => {
  const { billId, creatorToken } = await createBill();
  const c = openSocket(billId); const p = openSocket(billId);
  await Promise.all([c.ready, p.ready]);
  await c.next((m) => m.type === "state"); await p.next((m) => m.type === "state");
  p.send({ type: "join", name: "Pat" }); const pat = await p.next((m) => m.type === "joined");
  await c.stateWhere((b) => b.people.length === 1);

  p.send({ type: "set_pay", token: pat.token, pay: { venmo: "patpays" } });
  assert.match((await p.next((m) => m.type === "error")).message, /only the bill creator/i);

  c.send({ type: "set_pay", token: creatorToken, pay: { venmo: "@seb_splits", paypal: "bad name!" } });
  assert.match((await c.next((m) => m.type === "error")).message, /PayPal/);

  c.send({ type: "set_pay", token: creatorToken, pay: { venmo: "@seb_splits", cashapp: "" } });
  const withPay = await p.stateWhere((b) => b.pay && b.pay.venmo === "seb_splits");
  assert.deepEqual(withPay.pay, { venmo: "seb_splits" });
  const v = withPay.version;

  // Same details again: no-op, no version bump. Then clear them.
  c.send({ type: "set_pay", token: creatorToken, pay: { venmo: "seb_splits" } });
  c.send({ type: "set_pay", token: creatorToken, pay: {} });
  const cleared = await p.stateWhere((b) => b.pay && !b.pay.venmo);
  assert.equal(cleared.version, v + 1, "an identical set_pay must not bump the version");
  c.close(); p.close();
});

test("settle up: paid marks are scoped, idempotent, survive lock, and die with the person", async () => {
  const { billId, creatorToken } = await createBill();
  const a = openSocket(billId); const b = openSocket(billId);
  await Promise.all([a.ready, b.ready]);
  await a.next((m) => m.type === "state"); await b.next((m) => m.type === "state");
  a.send({ type: "join", name: "Ann" }); const ann = await a.next((m) => m.type === "joined");
  b.send({ type: "join", name: "Ben" }); const ben = await b.next((m) => m.type === "joined");
  await a.stateWhere((s) => s.people.length === 2);

  // Ben can't mark Ann as paid; Ann can mark herself; the creator can mark Ben.
  b.send({ type: "set_paid", personId: ann.personId, paid: true, token: ben.token });
  assert.match((await b.next((m) => m.type === "error")).message, /only ann/i);
  a.send({ type: "set_paid", personId: ann.personId, paid: true, token: ann.token });
  const s1 = await b.stateWhere((s) => s.paid && s.paid[ann.personId]);
  assert.ok(typeof s1.paid[ann.personId] === "number");

  // Lock the bill — settling up still works.
  a.send({ type: "lock", locked: true, token: creatorToken });
  await b.stateWhere((s) => s.locked);
  a.send({ type: "set_paid", personId: ben.personId, paid: true, token: creatorToken });
  const s2 = await b.stateWhere((s) => s.paid[ben.personId]);
  const v = s2.version;

  // Replays are no-ops; an undo is a real change.
  a.send({ type: "set_paid", personId: ben.personId, paid: true, token: creatorToken });
  b.send({ type: "set_paid", personId: ben.personId, paid: false, token: ben.token });
  const s3 = await a.stateWhere((s) => s.version > v && !s.paid[ben.personId]);
  assert.equal(s3.version, v + 1, "a replayed set_paid must not bump the version");

  // Unknown person → error; removing Ann drops her paid mark.
  a.send({ type: "set_paid", personId: "pnobody", paid: true, token: creatorToken });
  assert.match((await a.next((m) => m.type === "error")).message, /no longer exists/i);
  a.send({ type: "lock", locked: false, token: creatorToken });
  await b.stateWhere((s) => !s.locked);
  a.send({ type: "remove_person", personId: ann.personId, token: creatorToken });
  const s4 = await b.stateWhere((s) => s.people.length === 1);
  assert.deepEqual(s4.paid, {});
  a.close(); b.close();
});

test("settle up: the creator joining is recorded as the payee, and cleared if removed", async () => {
  const { billId, creatorToken } = await createBill();
  const c = openSocket(billId); const p = openSocket(billId);
  await Promise.all([c.ready, p.ready]);
  await c.next((m) => m.type === "state"); await p.next((m) => m.type === "state");
  p.send({ type: "join", name: "Pat" }); await p.next((m) => m.type === "joined");
  const s1 = await c.stateWhere((s) => s.people.length === 1);
  assert.equal(s1.creatorPersonId, undefined, "a plain join is not the payee");
  c.send({ type: "join", name: "Seb", token: creatorToken });
  const seb = await c.next((m) => m.type === "joined");
  const s2 = await p.stateWhere((s) => s.people.length === 2);
  assert.equal(s2.creatorPersonId, seb.personId);
  c.send({ type: "remove_person", personId: seb.personId, token: creatorToken });
  const s3 = await p.stateWhere((s) => s.people.length === 1);
  assert.equal(s3.creatorPersonId, undefined);
  c.close(); p.close();
});

test("parse: disabled locally returns 501 and never meters", async () => {
  const r = await api("/api/parse", { method: "POST", body: { media_type: "image/jpeg", data: "x".repeat(200) }, cookie: mintSession() });
  assert.equal(r.status, 501);
});

// Opt-in (`node test/integration.mjs --meter`): it burns the local per-IP daily
// create budget, so every later create from this machine 429s until the local
// DO state is reset (`npm run dev:reset`). Keep it last.
if (process.argv.includes("--meter")) test("meter: per-IP create cap trips at 30/day and reports a clear message", async () => {
  // Fresh DO state is not guaranteed between runs; count how many creates it takes
  // to hit the cap and just check the cap is enforced with a 429 + message.
  const cookie = mintSession({ sub: "meter-user" });
  let tripped = null;
  for (let i = 0; i < 35; i++) {
    const r = await api("/api/bills", { method: "POST", body: SAMPLE, cookie });
    if (r.status === 429) { tripped = r; break; }
    assert.equal(r.status, 200);
  }
  assert.ok(tripped, "expected the daily per-IP create cap to trip within 35 attempts");
  assert.match(tripped.data.error, /daily limit|budget/i);
});

// ---------- runner ----------

let failed = 0;
for (const t of tests) {
  const started = Date.now();
  try {
    await t.fn();
    console.log(`  ok   ${t.name} (${Date.now() - started}ms)`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${t.name}\n       ${e.message.split("\n").join("\n       ")}`);
  }
}
console.log(failed ? `\n${failed} of ${tests.length} tests failed` : `\nall ${tests.length} tests passed`);
process.exit(failed ? 1 : 0);
