// Offline receipt input regressions. Every request and decoded photo is fake;
// this suite never contacts Splitty, Stripe, or an image-recognition provider.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPage } from "./dom-harness.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) });
const account = { isPro: true, canScan: true, billsLimit: null, billsLeft: null, scansLimit: 30, scansLeft: 30 };
const me = { user: { email: "synthetic@example.test" }, account };
const draft = { restaurant: "Fictional cafe", items: [{ name: "Lunch", priceCents: 1200, qty: 1 }], taxCents: 100, tipOrServiceCents: 0, warnings: [] };

async function page({ request, bitmap, encode, imageFallback } = {}) {
  const requests = [], timers = new Map(), drawing = [], released = [], events = new Map();
  let timerId = 0;
  const p = loadPage("index.html", { allowBillBootstrap: true, beforeScripts(context) {
    context.location.pathname = "/";
    context.addEventListener = (type, fn) => { const listeners = events.get(type) || []; listeners.push(fn); events.set(type, listeners); };
    context.AbortController = AbortController;
    context.btoa = btoa;
    context.setTimeout = (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; };
    context.clearTimeout = (id) => timers.delete(id);
    context.fetch = async (url, options = {}) => {
      requests.push({ url, options });
      if (request) {
        const result = request(url, options, requests);
        if (result !== undefined) return result;
      }
      if (url === "/api/config") return response({ parseEnabled: true, authRequired: true });
      if (url === "/api/me") return response(me);
      throw new Error("Unexpected offline request: " + url);
    };
    context.createImageBitmap = bitmap || (async () => ({ width: 3024, height: 4032, close() { released.push("bitmap"); } }));
    if (imageFallback) imageFallback(context, released);
    const createElement = context.document.createElement;
    context.document.createElement = (tag) => {
      const el = createElement(tag);
      if (tag === "canvas") {
        const ctx = { fillStyle: "", fillRect(...args) { drawing.push({ op: "fill", color: this.fillStyle, args }); }, drawImage(...args) { drawing.push({ op: "draw", args }); } };
        el.getContext = () => ctx;
        el.toBlob = (fn, type, quality) => { drawing.push({ op: "encode", width: el.width, height: el.height, type, quality }); fn(encode ? encode() : new Blob([new Uint8Array(120)])); };
      }
      return el;
    };
  } });
  await tick();
  p.element("tipMode").value = "percent";
  return Object.assign(p, { requests, timers, drawing, released, events,
    photo(file = { name: "synthetic.png", type: "image/png" }) {
      const input = p.element("photoInput"); input.files = file ? [file] : []; input.value = file ? "synthetic.png" : "";
      return input.listeners.get("change")[0]({ target: input });
    },
    setItems() { p.run('$("itemRows").innerHTML = ""; addRow("Lunch", 1200, 1); updateTotal();'); },
  });
}

test("a pending create stays locked across account refresh and repeated activation", async () => {
  const pending = deferred();
  const p = await page({ request: (url) => url === "/api/bills" ? pending.promise : undefined });
  p.setItems();
  const first = p.element("createBtn").onclick();
  p.run("refreshGates()");
  assert.equal(p.element("createBtn").disabled, true);
  assert.equal(p.element("createBtn").textContent, "Creating…");
  const second = p.element("createBtn").onclick();
  assert.equal(p.requests.filter(({ url }) => url === "/api/bills").length, 1);
  pending.resolve(response({ billId: "synthetic", creatorToken: "private-test-token" }));
  await Promise.all([first, second]);
  assert.equal(p.context.location.href, "/b/synthetic");
});

test("a receipt without a tip replaces the prior receipt's tip", async () => {
  const p = await page();
  p.context.draft = draft;
  p.run('$("tipMode").value = "amount"; $("tipValue").value = "9.00"; applyDraft(draft);');
  assert.equal(p.element("totalPreview").textContent, "$13.00");
  assert.equal(p.element("tipValue").value, "");
});

test("photos shrink, flatten transparency onto white, and release the decoded bitmap", async () => {
  const p = await page();
  const out = await p.context.downscale({ type: "image/png" });
  assert.equal(out.mediaType, "image/jpeg");
  assert.equal(out.data.length, 160);
  const encoding = p.drawing.find(({ op }) => op === "encode");
  assert.equal(encoding.width, 1176);
  assert.equal(encoding.height, 1568);
  assert.equal(p.drawing[0].op, "fill");
  assert.equal(p.drawing[0].color, "#fff");
  assert.deepEqual(p.released, ["bitmap"]);
});

test("a hanging allowance refresh cannot keep a completed scan locked", async () => {
  const hang = deferred();
  const p = await page({ request: (url, options, requests) => {
    if (url === "/api/parse") return response({ draft });
    if (url === "/api/me" && requests.filter((r) => r.url === url).length > 1) return hang.promise;
  } });
  const scanning = p.photo();
  await tick();
  assert.equal(p.element("scanBtn").disabled, false);
  assert.equal(p.element("createBtn").disabled, false);
  hang.resolve(response(me));
  await scanning;
});

test("cancelling the native picker has no scan or allowance side effect", async () => {
  const p = await page();
  await p.photo(null);
  assert.deepEqual(p.requests.map(({ url }) => url), ["/api/config", "/api/me"]);
  assert.equal(p.element("scanBtn").disabled, false);
});

test("cancel during decoding prevents upload and releases a late bitmap", async () => {
  const decoding = deferred(), released = [];
  const p = await page({ bitmap: () => decoding.promise });
  const scanning = p.photo();
  await p.photo(); // second change while preparation is already active
  p.element("cancelScanBtn").click();
  assert.equal(p.element("scanBtn").disabled, false);
  assert.equal(p.element("photoInput").value, "");
  assert.match(p.element("errorBox").textContent, /not sent for processing/);
  decoding.resolve({ width: 100, height: 200, close() { released.push(true); } });
  await scanning;
  assert.deepEqual(released, [true]);
  assert.equal(p.requests.filter(({ url }) => url === "/api/parse").length, 0);
});

test("cancel after upload aborts, discloses possible usage and ignores a late response", async () => {
  const pending = deferred();
  const p = await page({ request: (url) => url === "/api/parse" ? pending.promise : undefined });
  p.setItems();
  const scanning = p.photo();
  await tick();
  const upload = p.requests.find(({ url }) => url === "/api/parse");
  p.element("cancelScanBtn").click();
  assert.equal(upload.options.signal.aborted, true);
  assert.match(p.element("errorBox").textContent, /attempt may still count/);
  p.element("restaurant").value = "Keep my correction";
  pending.resolve(response({ draft }));
  await scanning;
  assert.equal(p.element("restaurant").value, "Keep my correction");
  assert.equal(p.element("cancelScanBtn").classList.contains("hidden"), true);
  assert.equal(p.element("createBtn").disabled, false);
});

test("a stalled upload times out with manual recovery and no automatic retry", async () => {
  const pending = deferred();
  const p = await page({ request: (url) => url === "/api/parse" ? pending.promise : undefined });
  const scanning = p.photo(); await tick();
  [...p.timers.values()].find(({ ms }) => ms === 90_000).fn();
  assert.equal(p.requests.find(({ url }) => url === "/api/parse").options.signal.aborted, true);
  assert.match(p.element("errorBox").textContent, /took too long.*may still count/);
  assert.equal(p.element("scanBtn").disabled, false);
  assert.equal(p.requests.filter(({ url }) => url === "/api/parse").length, 1);
  pending.resolve(response({ draft })); await scanning;
});

test("a cancelled upload cannot overwrite or unlock a later scan", async () => {
  const first = deferred(), second = deferred();
  let calls = 0;
  const p = await page({ request: (url) => url === "/api/parse" ? (++calls === 1 ? first.promise : second.promise) : undefined });
  const firstScan = p.photo(); await tick(); p.element("cancelScanBtn").click();
  const secondScan = p.photo(); await tick();
  first.resolve(response({ draft: { ...draft, restaurant: "Old receipt" } })); await firstScan;
  assert.equal(p.element("restaurant").value, "");
  assert.equal(p.element("scanBtn").disabled, true);
  second.resolve(response({ draft: { ...draft, restaurant: "New receipt" } })); await secondScan;
  assert.equal(p.element("restaurant").value, "New receipt");
});

test("an encoding failure releases memory, sends nothing, and restores controls", async () => {
  const p = await page({ encode: () => null });
  await p.photo();
  assert.deepEqual(p.released, ["bitmap"]);
  assert.match(p.element("errorBox").textContent, /smaller image/);
  assert.equal(p.requests.filter(({ url }) => url === "/api/parse").length, 0);
  assert.equal(p.element("scanBtn").disabled, false);
  assert.equal(p.element("photoInput").value, "");
});

test("mobile image-element fallback stays local and revokes its object URL", async () => {
  const p = await page({ bitmap: async () => { throw new Error("bitmap decoder unsupported"); }, imageFallback(context, released) {
    context.URL = class extends URL {
      static createObjectURL() { return "blob:synthetic-photo"; }
      static revokeObjectURL(url) { released.push(url); }
    };
    context.Image = class {
      naturalWidth = 4032; naturalHeight = 3024;
      set src(value) { if (value) this.onload(); }
    };
  } });
  const out = await p.context.downscale({ type: "image/heic" });
  assert.equal(out.mediaType, "image/jpeg");
  assert.deepEqual(p.released, ["blob:synthetic-photo"]);
  assert.equal(p.drawing.find(({ op }) => op === "encode").width, 1568);
  assert.equal(p.requests.filter(({ url }) => url === "/api/parse").length, 0);
});

test("unreadable fallback photo gives format guidance and releases its URL", async () => {
  const p = await page({ bitmap: async () => { throw new Error("bad photo"); }, imageFallback(context, released) {
    context.URL = class extends URL {
      static createObjectURL() { return "blob:unreadable"; }
      static revokeObjectURL(url) { released.push(url); }
    };
    context.Image = class { set src(value) { if (value) this.onerror(); } };
  } });
  await p.photo();
  assert.match(p.element("errorBox").textContent, /JPEG or PNG/);
  assert.deepEqual(p.released, ["blob:unreadable"]);
  assert.equal(p.requests.filter(({ url }) => url === "/api/parse").length, 0);
});

test("typing while scanning preserves edits until the returned draft is explicitly applied", async () => {
  const pending = deferred();
  const p = await page({ request: (url) => url === "/api/parse" ? pending.promise : undefined });
  const scanning = p.photo(); await tick();
  p.element("restaurant").value = "My correction";
  p.element("payVenmo").value = "my-handle";
  pending.resolve(response({ draft })); await scanning;
  assert.equal(p.element("restaurant").value, "My correction");
  assert.equal(p.element("applyScanBtn").classList.contains("hidden"), false);
  p.element("applyScanBtn").click();
  assert.equal(p.element("restaurant").value, "Fictional cafe");
  assert.equal(p.element("payVenmo").value, "my-handle");
  assert.equal(p.element("applyScanBtn").classList.contains("hidden"), true);
});

test("starting another scan discards the previous unapplied draft even if it fails", async () => {
  const pending = deferred(); let calls = 0;
  const p = await page({ request: (url) => url === "/api/parse" ? (++calls === 1 ? pending.promise : response({ error: "Unreadable receipt" }, 422)) : undefined });
  const scanning = p.photo(); await tick();
  p.element("restaurant").value = "Keep manual edits";
  pending.resolve(response({ draft })); await scanning;
  assert.equal(p.element("applyScanBtn").classList.contains("hidden"), false);
  await p.photo();
  assert.equal(p.element("applyScanBtn").classList.contains("hidden"), true);
  p.element("applyScanBtn").onclick();
  assert.equal(p.element("restaurant").value, "Keep manual edits");
});

test("creating manually aborts and ignores the unfinished scan", async () => {
  const pending = deferred();
  const p = await page({ request: (url) => url === "/api/parse" ? pending.promise : url === "/api/bills" ? response({ billId: "manual", creatorToken: "test" }) : undefined });
  p.setItems(); const scanning = p.photo(); await tick();
  await p.element("createBtn").onclick();
  assert.equal(p.requests.find(({ url }) => url === "/api/parse").options.signal.aborted, true);
  assert.match(p.element("errorBox").textContent, /may still count/);
  assert.equal(p.context.location.href, "/b/manual");
  pending.resolve(response({ draft })); await scanning;
  assert.equal(p.element("restaurant").value, "");
});

test("malformed drafts cannot clear existing corrections", async () => {
  const p = await page({ request: (url) => url === "/api/parse" ? response({ draft: { items: [null] } }) : undefined });
  p.setItems(); await p.photo();
  assert.equal(p.element("itemRows").querySelector(".name").value, "Lunch");
  assert.equal(p.element("totalPreview").textContent, "$12.00");
  assert.match(p.element("errorBox").textContent, /readable items/);
});

test("invalid correction inputs never silently create different amounts or quantities", async () => {
  const p = await page(); p.setItems();
  const row = p.element("itemRows").querySelector(".item-row");
  for (const [selector, value, message] of [[".qty", "2.5", /whole quantity/], [".qty", "100", /whole quantity/], [".price", "-2", /line total/], [".price", "1.234", /decimal places/]]) {
    row.querySelector(".qty").value = "1"; row.querySelector(".price").value = "12.00";
    row.querySelector(selector).value = value;
    await p.element("createBtn").onclick();
    assert.match(p.element("errorBox").textContent, message);
    assert.equal(p.document.activeElement, row.querySelector(selector));
  }
  row.querySelector(".price").value = "12.00"; row.querySelector(".name").value = "";
  await p.element("createBtn").onclick();
  assert.match(p.element("errorBox").textContent, /Give each priced item a name/);
  assert.equal(p.requests.filter(({ url }) => url === "/api/bills").length, 0);
});

test("a failed creation can be corrected and retried once, keeping entered details", async () => {
  let calls = 0;
  const p = await page({ request: (url) => url === "/api/bills" ? (++calls === 1 ? response({ error: "Temporary failure" }, 503) : response({ billId: "retry", creatorToken: "test" })) : undefined });
  p.setItems(); await p.element("createBtn").onclick();
  assert.equal(p.element("createBtn").disabled, false);
  assert.equal(p.element("itemRows").querySelector(".name").value, "Lunch");
  await p.element("createBtn").onclick();
  assert.equal(calls, 2);
  assert.equal(p.context.location.href, "/b/retry");
});

test("a stale allowance refresh cannot restore a signed-out account", async () => {
  const pending = deferred();
  const p = await page({ request: (url, options, requests) => url === "/api/me" && requests.filter((r) => r.url === url).length > 1 ? pending.promise : undefined });
  const refreshing = p.context.refreshMe();
  p.run("sessionLost()");
  pending.resolve(response(me)); await refreshing;
  assert.equal(p.run("user"), null);
  assert.equal(p.element("createBtn").disabled, true);
});

test("refreshing the same account during a scan does not discard its result", async () => {
  const pending = deferred();
  const p = await page({ request: (url) => url === "/api/parse" ? pending.promise : undefined });
  const scanning = p.photo(); await tick();
  await p.context.refreshMe();
  pending.resolve(response({ draft })); await scanning;
  assert.equal(p.element("restaurant").value, "Fictional cafe");
});

test("an allowance refresh from a cancelled scan cannot discard the next scan", async () => {
  const first = deferred(), second = deferred(), allowance = deferred(); let uploads = 0;
  const p = await page({ request: (url, options, requests) => {
    if (url === "/api/parse") return ++uploads === 1 ? first.promise : second.promise;
    if (url === "/api/me" && requests.filter((r) => r.url === url).length === 2) return allowance.promise;
  } });
  const scanA = p.photo(); await tick(); p.element("cancelScanBtn").click();
  const scanB = p.photo(); await tick();
  allowance.resolve(response(me)); await tick();
  second.resolve(response({ draft })); await scanB;
  assert.equal(p.element("restaurant").value, "Fictional cafe");
  first.resolve(response({ draft: { ...draft, restaurant: "Discarded" } })); await scanA;
  assert.equal(p.element("restaurant").value, "Fictional cafe");
});

test("signing out during a scan discards a late response without restoring Pro", async () => {
  const pending = deferred();
  const p = await page({ request: (url) => url === "/api/parse" ? pending.promise : undefined });
  const scanning = p.photo(); await tick();
  p.run("sessionLost()");
  pending.resolve(response({ draft, account })); await scanning;
  assert.equal(p.run("user"), null);
  assert.equal(p.run("account"), null);
  assert.equal(p.element("restaurant").value, "");
  assert.equal(p.element("createBtn").disabled, true);
});

test("receipt corrections expose mobile keyboard hints and accessible field names", async () => {
  const p = await page();
  const row = p.element("itemRows").querySelector(".item-row");
  assert.equal(row.querySelector(".price").getAttribute("inputmode"), "decimal");
  assert.match(row.querySelector(".price").getAttribute("aria-label"), /all units/);
  assert.equal(row.querySelector(".qty").getAttribute("inputmode"), "numeric");
  assert.ok(row.querySelector(".name").getAttribute("aria-label"));
  assert.equal(p.element("errorBox").getAttribute("role"), "status");
  assert.equal(p.effects.length, 0, "only explicitly mocked network and existing payment preferences are used");
});

test("Back restores Create after success while a pending request stays protected", async () => {
  const pending = deferred();
  const p = await page({ request: (url) => url === "/api/bills" ? pending.promise : undefined });
  p.setItems(); const creating = p.element("createBtn").onclick();
  const restore = () => p.events.get("pageshow").forEach((fn) => fn({ persisted: true }));
  restore();
  assert.equal(p.element("createBtn").disabled, true);
  pending.resolve(response({ billId: "restored", creatorToken: "test" })); await creating;
  assert.equal(p.element("createBtn").disabled, true);
  restore();
  assert.equal(p.element("createBtn").disabled, false);
  assert.equal(p.element("createBtn").textContent, "Create bill & get share link");
  assert.equal(p.element("itemRows").querySelector(".name").value, "Lunch");
});
