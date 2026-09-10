// Execute the shipped bill page against deterministic, entirely offline network
// and browser lifecycle fakes. No live bills, payments, credentials or sockets.
// Run: node test/bill-connection.mjs
import assert from "node:assert/strict";
import { loadPage } from "./dom-harness.mjs";

const tests = [];
const test = (name, run) => tests.push({ name, run });
const id = "a".repeat(22);
const identityKey = "splitty-me-" + id;
const creatorKey = "splitty-creator-" + id;
const guest = { personId: "guest", token: "private-person-token" };
const tick = () => new Promise(setImmediate);
const visible = (element) => !element.classList.contains("hidden");
const snapshot = (version = 1) => ({
  id, restaurant: "Connection test", version, locked: false, creatorPersonId: "host", pay: { venmo: "host-name" }, paid: {},
  people: [{ id: "host", name: "Host", color: "#111" }, { id: "guest", name: "Guest", color: "#222" }],
  items: [{ id: "lunch", name: "Lunch", priceCents: 1200, qty: 1 }], claims: { lunch: { guest: 1 } },
  taxCents: 100, tip: { mode: "percent", value: 10 },
});
const response = (status = 200) => ({ status, ok: status === 200, json: async () => ({ bill: snapshot() }) });

async function setup({ storage = { [identityKey]: JSON.stringify(guest) }, online = true, hash = "", getResponse = () => response(), socketFailure = false } = {}) {
  const timers = new Map(), sockets = [], requests = [], listeners = new Map(), history = [];
  let now = 0, timerId = 0;
  const schedule = (fn, delay, interval = false) => {
    const key = ++timerId;
    timers.set(key, { fn, at: now + delay, interval: interval ? delay : 0 });
    return key;
  };
  const page = loadPage("bill.html", { storage, allowBillBootstrap: true, beforeScripts(context) {
    context.location.hash = hash;
    context.history.replaceState = (...args) => { history.push(args); context.location.hash = ""; };
    context.navigator.onLine = online;
    context.document.visibilityState = "visible";
    context.addEventListener = (name, fn) => { const list = listeners.get(name) || []; list.push(fn); listeners.set(name, list); };
    context.setTimeout = (fn, delay) => schedule(fn, delay);
    context.setInterval = (fn, delay) => schedule(fn, delay, true);
    context.clearTimeout = context.clearInterval = (key) => timers.delete(key);
    context.Math = Object.create(Math); context.Math.random = () => 0;
    context.fetch = async (url, options) => {
      assert.equal(url, "/api/bills/" + id);
      assert.equal(options.cache, "no-store");
      const request = { url, options }; requests.push(request);
      return getResponse(request, requests.length);
    };
    context.WebSocket = class {
      constructor(url) {
        assert.equal(url, "wss://splitty.test/api/bills/" + id + "/ws");
        if (socketFailure) throw new Error("WebSocket unavailable");
        this.readyState = 0; this.sent = []; sockets.push(this);
      }
      open() { this.readyState = 1; this.onopen?.({}); }
      send(raw) { assert.equal(this.readyState, 1); if (this.sendFailure) throw new Error("Send failed"); this.sent.push(raw); }
      close(code = 1000, reason = "") { this.readyState = 3; this.onclose?.({ code, reason }); }
      receive(value) { this.onmessage?.({ data: value === "pong" ? value : JSON.stringify(value) }); }
      state(bill = snapshot()) { this.open(); this.receive({ type: "state", bill }); }
      mutations() { return this.sent.filter((value) => value !== "ping").map((value) => JSON.parse(value)); }
    };
  } });
  await tick();
  return { ...page, sockets, requests, timers, history,
    latest: () => sockets.at(-1),
    async event(type, extra = {}) { for (const fn of listeners.get(type) || []) fn({ type, ...extra }); await tick(); },
    async visibility(value) { page.document.visibilityState = value; page.document.dispatchEvent({ type: "visibilitychange" }); await tick(); },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [key, timer] = next; now = timer.at;
        if (timer.interval) timer.at += timer.interval; else timers.delete(key);
        timer.fn(); await tick();
      }
      now = target; await tick();
    },
    join(name = "New guest") { page.element("joinName").value = name; page.element("joinForm").dispatchEvent({ type: "submit" }); },
  };
}

test("opening a bill offline waits and recovers on online without showing expiry", async () => {
  const page = await setup({ online: false });
  assert.equal(page.requests.length, 0);
  assert.ok(page.document.getElementById("joinForm"));
  assert.match(page.element("conn").textContent, /offline/);
  page.context.navigator.onLine = true; await page.event("online");
  page.latest().state();
  assert.equal(visible(page.element("billView")), true);
  assert.equal(page.element("conn").classList.contains("off"), false);
});

for (const failure of ["network", 500, 429]) {
  test(`initial ${failure} failure retries and preserves the bill page`, async () => {
    const page = await setup({ getResponse: (_, count) => {
      if (count > 1) return response();
      if (failure === "network") throw new Error("offline");
      return response(failure);
    } });
    assert.ok(page.document.getElementById("joinForm"));
    assert.equal(page.sockets.length, 0);
    await page.advance(500); page.latest().state();
    assert.equal(visible(page.element("billView")), true);
    assert.equal(page.requests.length, 2);
  });
}

for (const status of [404, 410]) {
  test(`confirmed ${status} ends retries and renders the missing bill screen`, async () => {
    const page = await setup({ getResponse: () => response(status) });
    assert.equal(page.document.getElementById("joinForm"), null);
    assert.match(page.document.querySelector("main").textContent, /doesn't exist/);
    await page.advance(60000); await page.event("online");
    assert.equal(page.requests.length, 1);
    assert.equal(page.sockets.length, 0);
  });
}

test("a stalled HTTP attempt times out and its late response cannot replace the active socket", async () => {
  let finish;
  const page = await setup({ getResponse: (_, count) => count === 1 ? new Promise((resolve) => { finish = resolve; }) : response() });
  await page.advance(15500);
  assert.equal(page.requests[0].options.signal.aborted, true);
  assert.equal(page.sockets.length, 1);
  page.latest().state(snapshot(3));
  finish(response(404)); await tick();
  assert.ok(page.document.getElementById("billView"));
  assert.equal(page.sockets.length, 1);
  assert.equal(page.run("bill.version"), 3);
});

test("a stalled socket or missing initial snapshot retries, even after open", async () => {
  const page = await setup(); page.latest().open();
  assert.equal(page.run("sendMsg({type:'lock',locked:true})"), false);
  assert.deepEqual(page.latest().mutations(), []);
  await page.advance(15500);
  assert.equal(page.sockets.length, 2);
  assert.equal(page.sockets[0].readyState, 3);
  page.latest().state();
  assert.equal(page.element("conn").classList.contains("off"), false);
});

test("WebSocket constructor failure is recoverable instead of an unhandled rejection", async () => {
  const page = await setup({ socketFailure: true });
  assert.ok(page.document.getElementById("joinForm"));
  await page.advance(500);
  assert.equal(page.requests.length, 2);
  assert.equal(page.sockets.length, 0);
});

test("mobile resume replaces an apparently open socket and waits for a current snapshot", async () => {
  const page = await setup(); const old = page.latest(); old.state();
  const oldPaidButton = page.element("personTotals").querySelector(".paidbtn");
  await page.visibility("hidden"); await page.visibility("visible");
  const fresh = page.latest(); fresh.open();
  assert.notEqual(fresh, old);
  oldPaidButton.click(); assert.deepEqual(fresh.mutations(), []);
  old.receive({ type: "state", bill: snapshot(90) }); old.close(1000, "gone");
  assert.equal(page.run("bill.version"), 1);
  assert.ok(page.document.getElementById("billView"));
  fresh.state(snapshot(2));
  oldPaidButton.click();
  assert.equal(fresh.mutations().at(-1).expectedVersion, 1, "retained payment intent must still carry the amount version actually displayed");
  page.element("personTotals").querySelector(".paidbtn").click();
  assert.equal(fresh.mutations().at(-1).expectedVersion, 2);
  assert.equal(old.mutations().length, 0);
});

test("restoring a page from the back-forward cache reconnects without rejoining", async () => {
  const page = await setup(); page.latest().state();
  await page.event("pagehide");
  assert.equal(page.latest().readyState, 3);
  await page.event("pageshow", { persisted: true }); page.latest().state();
  assert.equal(page.sockets.length, 2);
  assert.deepEqual(page.sockets.flatMap((socket) => socket.mutations()), []);
  assert.equal(page.run("me.personId"), "guest");
});

test("missed pong detects an otherwise open dead socket, while timely pong keeps it", async () => {
  const page = await setup(); const socket = page.latest(); socket.state();
  await page.advance(25000); assert.deepEqual(socket.sent, ["ping"]);
  socket.receive("pong"); await page.advance(10000);
  assert.equal(page.sockets.length, 1);
  await page.advance(25500);
  assert.equal(page.sockets.length, 2);
  assert.equal(socket.readyState, 3);
});

test("offline edits stay in their form and are not replayed when the connection returns", async () => {
  const page = await setup({ storage: { [creatorKey]: "private-creator-token" } }); page.latest().state();
  page.element("editBtn").click(); page.element("editRestaurant").value = "Unsaved restaurant";
  page.context.navigator.onLine = false; await page.event("offline");
  page.element("editSave").click();
  assert.equal(visible(page.element("editView")), true);
  assert.match(page.element("errorBox").textContent, /offline/);
  page.context.navigator.onLine = true; await page.event("online"); page.latest().state(snapshot(2));
  assert.equal(visible(page.element("editView")), true);
  assert.equal(page.element("editRestaurant").value, "Unsaved restaurant");
  assert.deepEqual(page.sockets.flatMap((socket) => socket.mutations()), []);
  page.element("editSave").click();
  assert.equal(page.latest().mutations().at(-1).bill.restaurant, "Unsaved restaurant");
});

test("synchronous send failure preserves the edit form and never throws to the UI", async () => {
  const page = await setup({ storage: { [creatorKey]: "private-creator-token" } }); page.latest().state();
  page.element("editBtn").click(); page.latest().sendFailure = true;
  assert.doesNotThrow(() => page.element("editSave").click());
  assert.equal(visible(page.element("editView")), true);
  assert.deepEqual(page.sockets.flatMap((socket) => socket.mutations()), []);
});

test("payment deep links cannot open with an offline or superseded bill amount", async () => {
  const page = await setup(); page.latest().state();
  const link = page.element("personTotals").querySelector(".paylink");
  let prevented = 0;
  page.context.navigator.onLine = false;
  link.dispatchEvent({ type: "click", preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  page.context.navigator.onLine = true; await page.event("online"); page.latest().state(snapshot(2));
  link.dispatchEvent({ type: "click", preventDefault() { prevented++; } });
  assert.equal(prevented, 2);
  page.element("personTotals").querySelector(".paylink").dispatchEvent({ type: "click", preventDefault() { prevented++; } });
  assert.equal(prevented, 2);
});

test("offline payment links have no destination until a fresh snapshot restores the current amount", async () => {
  const page = await setup(); page.latest().state();
  const original = page.element("personTotals").querySelector(".paylink");
  assert.ok(original.getAttribute("href"));
  assert.equal(new URL(original.getAttribute("href")).searchParams.get("amount"), "14.20");
  assert.match(original.textContent, /14\.20/);
  page.context.navigator.onLine = false; await page.event("offline");
  assert.equal(original.getAttribute("href"), null, "long-press/open-link must have no payment destination");
  assert.equal(original.getAttribute("aria-disabled"), "true");
  page.run("render()");
  const offline = page.element("personTotals").querySelector(".paylink");
  assert.equal(offline.getAttribute("href"), null, "a local rerender must not restore a stale link");
  page.context.navigator.onLine = true; await page.event("online"); page.latest().open();
  assert.equal(offline.getAttribute("href"), null, "socket open alone cannot restore payment links");
  const current = snapshot(2); current.items[0].priceCents = 2200;
  page.latest().state(current);
  const fresh = page.element("personTotals").querySelector(".paylink");
  assert.match(fresh.textContent, /25\.20/);
  assert.equal(new URL(fresh.getAttribute("href")).searchParams.get("amount"), "25.20");
  assert.equal(fresh.getAttribute("aria-disabled"), null);
  assert.equal(offline.getAttribute("href"), null, "a retained detached link stays disabled");
});

test("repeated Join taps send only one request until its acknowledgment", async () => {
  const page = await setup({ storage: {} }); page.latest().state();
  page.join(); page.join();
  assert.equal(page.latest().mutations().length, 1);
  assert.equal(page.element("joinForm").querySelector("button").disabled, true);
  page.latest().receive({ type: "joined", ...guest });
  page.latest().state(snapshot(2)); page.join();
  assert.equal(page.latest().mutations().length, 1);
  assert.equal(JSON.parse(page.storage[identityKey]).personId, "guest");
});

test("a rejected Join can be corrected and retried", async () => {
  const page = await setup({ storage: {} }); page.latest().state(); page.join();
  page.latest().receive({ type: "error", message: "This bill is locked." });
  assert.equal(page.element("joinForm").querySelector("button").disabled, false);
  page.join(); assert.equal(page.latest().mutations().length, 2);
});

test("a lost Join acknowledgment does not replay or take another person's identity", async () => {
  const page = await setup({ storage: {} }); page.latest().state(); page.join();
  page.latest().close(1006, ""); await page.advance(500); page.latest().state(snapshot(2));
  assert.equal(page.sockets.flatMap((socket) => socket.mutations()).length, 1);
  assert.equal(page.run("me"), null);
  assert.match(page.element("errorBox").textContent, /Check the names/);
  assert.equal(page.element("joinForm").querySelector("button").disabled, false);
});

test("a silent Join times out instead of leaving the Join button permanently disabled", async () => {
  const page = await setup({ storage: {} }); page.latest().state(); page.join();
  await page.advance(15500); page.latest().state(snapshot(2));
  assert.equal(page.sockets.length, 2);
  assert.equal(page.element("joinForm").querySelector("button").disabled, false);
  assert.equal(page.sockets.flatMap((socket) => socket.mutations()).length, 1);
  assert.match(page.element("errorBox").textContent, /Joining was interrupted/);
});

test("opening Edit focuses its named first field without refocusing during live updates", async () => {
  const page = await setup({ storage: { [creatorKey]: "private-creator-token" } }); page.latest().state();
  page.element("editBtn").click();
  assert.equal(page.document.activeElement, page.element("editRestaurant"));
  assert.equal(page.element("editRestaurant").getAttribute("aria-label"), "Bill name");
  page.element("editTax").focus(); page.latest().state(snapshot(2));
  assert.equal(page.document.activeElement, page.element("editTax"));
  assert.equal(page.element("editTax").getAttribute("inputmode"), "decimal");
  assert.equal(page.element("editRows").querySelector(".rm").getAttribute("aria-label"), "Remove item");
});

test("saved guest identity reopens without a join; missing tokens or removed people ask to join", async () => {
  const saved = await setup(); saved.latest().state();
  assert.equal(visible(saved.element("billView")), true);
  assert.deepEqual(saved.latest().mutations(), []);
  for (const value of [{ personId: "guest" }, { personId: "removed", token: "old-token" }, "guest", null]) {
    const page = await setup({ storage: { [identityKey]: JSON.stringify(value) } }); page.latest().state();
    assert.equal(visible(page.element("joinView")), true);
    assert.equal(page.run("me"), null);
    assert.deepEqual(page.latest().mutations(), []);
  }
});

test("blocked browser storage does not prevent joining or using a creator backup link", async () => {
  const storage = new Proxy({}, { get() { throw new Error("Storage blocked"); }, set() { throw new Error("Storage blocked"); } });
  const token = "creator-backup-token";
  const page = await setup({ storage, hash: "#edit=" + token }); page.latest().state();
  assert.equal(page.run("creatorToken"), token);
  assert.equal(page.context.location.hash, "#edit=" + token, "keep the backup fragment when storage could not save it");
  assert.equal(visible(page.element("creatorTools")), true);
  page.join(); assert.equal(page.latest().mutations()[0].token, token);
  page.latest().receive({ type: "joined", ...guest }); page.latest().state(snapshot(2));
  assert.equal(page.run("me.personId"), "guest");
  assert.match(page.element("errorBox").textContent, /keep this tab open/);
});

test("stored creator backup links strip the fragment; malformed links preserve the stored token", async () => {
  const page = await setup({ storage: {}, hash: "#edit=creator-backup-token" });
  assert.equal(page.storage[creatorKey], "creator-backup-token");
  assert.equal(page.context.location.hash, "");
  const existing = await setup({ storage: { [creatorKey]: "existing-creator-token" }, hash: "#edit=broken" });
  assert.equal(existing.run("creatorToken"), "existing-creator-token");
});

let failed = 0;
for (const { name, run } of tests) {
  try { await run(); console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name, error); }
}
console.log(`${tests.length - failed}/${tests.length} bill connection tests passed`);
process.exitCode = failed ? 1 : 0;
