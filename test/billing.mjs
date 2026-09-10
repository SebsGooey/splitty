// Billing regression tests. All HTTP is intercepted; no Stripe credentials,
// running server, Cloudflare account, or real purchases are used.
// Run with Node 24+: node test/billing.mjs
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import worker, { Accounts } from "../src/worker.js";

const DAY = 86400_000;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Unexpected network request: billing tests never access the network"); };

function fixture() {
  const db = new DatabaseSync(":memory:");
  const ctx = { storage: {
    sql: { exec(query, ...params) {
      if (!params.length && query.includes(";")) { db.exec(query); return { toArray: () => [] }; }
      const rows = db.prepare(query).all(...params);
      return { toArray: () => rows };
    } },
    transactionSync(fn) {
      db.exec("BEGIN IMMEDIATE");
      try { const result = fn(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  } };
  const env = {
    GOOGLE_CLIENT_ID: "test-client", SESSION_SECRET: "unit-test-session-secret",
    STRIPE_SECRET_KEY: "unit-test-placeholder", STRIPE_WEBHOOK_SECRET: "unit-test-webhook-secret",
    STRIPE_PRICE_ID: "price_pro", STRIPE_PRODUCT_ID: "prod_pro", STRIPE_PORTAL_CONFIGURATION_ID: "bpc_splitty",
  };
  let accounts = new Accounts(ctx, env);
  env.ACCOUNTS = { idFromName: () => "global", get: () => ({ fetch: (...args) => accounts.fetch(new Request(...args)) }) };
  const mock = { customers: new Map(), sessions: new Map(), subscriptions: new Map(), invoices: new Map(), requests: [], idempotency: new Map(), lostResponse: null, failRead: false, gate: null };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://api.stripe.com", "Every upstream request must target the mocked Stripe API");
    assert.equal(init.headers["Stripe-Version"], "2026-08-26.dahlia");
    assert.equal(init.headers.authorization, "Bearer unit-test-placeholder");
    const method = init.method || "GET";
    const form = Object.fromEntries(new URLSearchParams(init.body || ""));
    mock.requests.push({ path: url.pathname, method, form, query: Object.fromEntries(url.searchParams), key: init.headers["Idempotency-Key"] });
    if (mock.gate?.path === url.pathname) {
      const gate = mock.gate;
      mock.gate = null;
      gate.entered();
      await gate.wait;
    }
    if (method === "GET" && mock.failRead) return Response.json({ error: { code: "mock_unavailable" } }, { status: 503 });
    let result;
    if (method === "POST") {
      const key = init.headers["Idempotency-Key"];
      if (url.pathname !== "/v1/billing_portal/sessions") assert.ok(key, "Every customer and checkout creation needs idempotency");
      const previous = key && mock.idempotency.get(key);
      if (previous) { assert.deepEqual(form, previous.form, "A replay must use identical parameters"); return Response.json(previous.result); }
      if (url.pathname === "/v1/customers") {
        result = { id: "cus_" + (mock.customers.size + 1), metadata: { sub: form["metadata[sub]"] } };
        mock.customers.set(result.id, result);
      } else if (url.pathname === "/v1/checkout/sessions") {
        assert.equal(form["line_items[0][price]"], "price_pro");
        assert.equal(form.mode, "subscription");
        assert.equal(form["payment_method_types[0]"], undefined);
        assert.match(form.integration_identifier, /^splitty-pro-[a-z]{8}$/);
        assert.match(form["custom_text[submit][message]"], /https:\/\/splitty\.test\/terms/);
        result = { id: "cs_" + (mock.sessions.size + 1), customer: form.customer, status: "open", payment_status: "unpaid", expires_at: Number(form.expires_at), url: "https://checkout.stripe.com/mock/" + (mock.sessions.size + 1), metadata: { sub: form["metadata[sub]"] } };
        mock.sessions.set(result.id, result);
      } else if (url.pathname === "/v1/billing_portal/sessions") {
        assert.equal(form.configuration, "bpc_splitty");
        result = { url: "https://billing.stripe.com/mock/portal" };
      } else throw new Error("Unexpected mocked Stripe write: " + url.pathname);
      if (key) mock.idempotency.set(key, { form, result: structuredClone(result) });
      if (mock.lostResponse === url.pathname) { mock.lostResponse = null; throw new Error("Simulated response loss after Stripe accepted request"); }
    } else if (url.pathname === "/v1/subscriptions") {
      result = { data: [...mock.subscriptions.values()].filter((s) => s.customer === url.searchParams.get("customer")), has_more: false };
    } else if (url.pathname.startsWith("/v1/subscriptions/")) {
      result = mock.subscriptions.get(url.pathname.split("/").at(-1));
    } else if (url.pathname === "/v1/invoices") {
      result = { data: (mock.invoices.get(url.searchParams.get("subscription")) || []).filter((i) => i.status === "paid"), has_more: false };
    } else if (url.pathname.startsWith("/v1/checkout/sessions/")) {
      result = mock.sessions.get(url.pathname.split("/").at(-1));
    } else throw new Error("Unexpected mocked Stripe read: " + url.pathname);
    assert.ok(result, "Mock object exists: " + url.pathname);
    return Response.json(structuredClone(result));
  };
  const cookie = (sub = "buyer") => {
    const raw = Buffer.from(JSON.stringify({ sub, email: sub + "@example.test", name: sub, exp: Date.now() + DAY })).toString("base64url");
    return "splitty_session=" + raw + "." + createHmac("sha256", env.SESSION_SECRET).update(raw).digest("base64url");
  };
  const api = async (path, { sub = "buyer", method = "GET", body } = {}) => {
    const response = await worker.fetch(new Request("https://splitty.test" + path, { method, headers: { cookie: cookie(sub) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
    return { status: response.status, data: await response.json() };
  };
  const checkout = (sub = "buyer") => api("/api/billing/checkout", { sub, method: "POST" });
  let eventNumber = 0;
  const event = (type, object, overrides = {}) => ({ id: "evt_" + ++eventNumber, type, created: 100, data: { object }, ...overrides });
  const webhook = async (value) => {
    const raw = JSON.stringify(value), time = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET).update(time + "." + raw).digest("hex");
    const response = await worker.fetch(new Request("https://splitty.test/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "t=" + time + ",v1=" + signature }, body: raw }), env);
    return { status: response.status, data: await response.json() };
  };
  const subscription = ({ sub = "buyer", id = "sub_main", customer, status = "active", end = Math.floor((Date.now() + 30 * DAY) / 1000), paid = true, price = "price_pro", product = "prod_pro", created = 100 } = {}) => {
    customer ||= [...mock.customers.values()].find((c) => c.metadata.sub === sub)?.id;
    const value = { id, customer, status, created, metadata: { sub }, cancel_at_period_end: false, items: { data: [{ id: "si_" + id, price: { id: price, product }, current_period_end: end }] } };
    mock.subscriptions.set(id, value);
    mock.invoices.set(id, paid ? [{ id: "in_" + id, status: "paid", lines: { has_more: false, data: [{ amount: 299, pricing: { price_details: { price } }, parent: { subscription_item_details: { subscription_item: "si_" + id } }, period: { end } }] } }] : []);
    return value;
  };
  const me = async (sub = "buyer") => (await api("/api/me", { sub })).data.account;
  const remove = async (sub = "buyer") => (await accounts.fetch(new Request("https://do/delete", { method: "POST", body: JSON.stringify({ sub }) }))).json();
  return { api, checkout, webhook, event, subscription, me, remove, mock, env, db, get accounts() { return accounts; }, restart() { accounts = new Accounts(ctx, env); } };
}

test("concurrent checkout and retries create one durable customer and one session", async () => {
  const f = fixture();
  const responses = await Promise.all(Array.from({ length: 12 }, () => f.checkout()));
  assert.ok(responses.every((r) => r.status === 200));
  assert.equal(new Set(responses.map((r) => r.data.url)).size, 1);
  assert.equal(f.mock.customers.size, 1);
  assert.equal(f.mock.sessions.size, 1);
  f.restart();
  assert.equal((await f.checkout()).data.url, responses[0].data.url);
  assert.equal(f.mock.sessions.size, 1);
  assert.equal((await f.me()).isPro, false);
});

for (const path of ["/v1/customers", "/v1/checkout/sessions"]) test("lost response is replayed safely across restart: " + path, async () => {
  const f = fixture();
  f.mock.lostResponse = path;
  assert.equal((await f.checkout()).status, 502);
  f.restart();
  assert.equal((await f.checkout()).status, 200);
  assert.equal(f.mock.customers.size, 1);
  assert.equal(f.mock.sessions.size, 1);
  const attempts = f.mock.requests.filter((r) => r.path === path && r.method === "POST");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].key, attempts[1].key);
});

test("ambiguous attempts older than Stripe idempotency retention fail closed", async () => {
  const f = fixture();
  f.mock.lostResponse = "/v1/customers";
  await f.checkout();
  f.db.prepare("UPDATE billing_state SET customer_started_at = ?").run(Date.now() - DAY);
  assert.equal((await f.checkout()).status, 409);
  assert.equal(f.mock.requests.filter((r) => r.path === "/v1/customers").length, 1);
});

test("one account's slow Stripe request does not block another account", async () => {
  const f = fixture();
  let entered, release;
  const ready = new Promise((resolve) => { entered = resolve; });
  f.mock.gate = { path: "/v1/customers", entered, wait: new Promise((resolve) => { release = resolve; }) };
  const first = f.checkout("first");
  await ready;
  assert.equal((await f.checkout("second")).status, 200);
  release();
  assert.equal((await first).status, 200);
});

test("unpaid checkout stays Free until a paid invoice, then grants actual period", async () => {
  const f = fixture();
  await f.checkout();
  const subscription = f.subscription({ paid: false });
  const session = f.mock.sessions.get("cs_1");
  Object.assign(session, { status: "complete", mode: "subscription", subscription: subscription.id, payment_status: "unpaid" });
  assert.equal((await f.webhook(f.event("checkout.session.completed", session))).status, 200);
  assert.equal((await f.me()).isPro, false);
  await f.webhook(f.event("checkout.session.async_payment_failed", session));
  assert.equal((await f.me()).isPro, false);
  f.subscription({ paid: true });
  await f.webhook(f.event("checkout.session.async_payment_succeeded", { ...session, payment_status: "paid" }));
  const account = await f.me();
  assert.equal(account.isPro, true);
  assert.equal(account.proUntil, subscription.items.data[0].current_period_end * 1000);
  assert.equal(account.stripeCustomer, undefined);
});

test("active, unpaid and incomplete subscriptions prevent another purchase before webhook", async () => {
  for (const status of ["active", "past_due", "unpaid", "incomplete", "paused"]) {
    const f = fixture();
    await f.checkout();
    f.subscription({ status, paid: status === "active" });
    assert.equal((await f.checkout()).status, 409, status);
    assert.equal(f.mock.sessions.size, 1);
  }
});

test("cancellation followed by stale and same-second events never restores Pro", async () => {
  const f = fixture();
  await f.checkout();
  const subscription = f.subscription();
  const stale = structuredClone(subscription);
  await f.webhook(f.event("customer.subscription.created", stale));
  assert.equal((await f.me()).isPro, true);
  subscription.status = "canceled";
  await f.webhook(f.event("customer.subscription.deleted", subscription));
  const old = f.event("customer.subscription.updated", stale);
  await f.webhook(old);
  await f.webhook(f.event("checkout.session.completed", { ...f.mock.sessions.get("cs_1"), subscription: subscription.id, mode: "subscription", payment_status: "paid" }));
  assert.equal((await f.me()).isPro, false);
  assert.equal((await f.me()).stripeStatus, "canceled");
  assert.equal((await f.webhook(old)).data.reason, "duplicate");
});

test("concurrent webhook notifications reconcile under the same account lock", async () => {
  const f = fixture();
  await f.checkout();
  const subscription = f.subscription();
  let entered, release;
  const ready = new Promise((resolve) => { entered = resolve; });
  f.mock.gate = { path: "/v1/subscriptions/sub_main", entered, wait: new Promise((resolve) => { release = resolve; }) };
  const first = f.webhook(f.event("customer.subscription.updated", structuredClone(subscription)));
  await ready;
  subscription.status = "canceled";
  const second = f.webhook(f.event("customer.subscription.deleted", subscription));
  release();
  assert.ok((await Promise.all([first, second])).every((r) => r.status === 200));
  assert.equal((await f.me()).isPro, false);
});

test("old and unrelated subscriptions do not revoke the current Pro subscription", async () => {
  const f = fixture();
  await f.checkout();
  const current = f.subscription({ id: "sub_new", created: 200 });
  const old = f.subscription({ id: "sub_old", status: "canceled", created: 100 });
  await f.webhook(f.event("customer.subscription.deleted", old));
  assert.equal((await f.me()).isPro, true);
  assert.equal(f.db.prepare("SELECT stripe_subscription FROM users").get().stripe_subscription, current.id);
  const other = f.subscription({ id: "sub_other", price: "price_other", product: "prod_other", status: "canceled" });
  assert.equal((await f.webhook(f.event("customer.subscription.deleted", other))).data.reason, "unrelated subscription");
  assert.equal((await f.me()).isPro, true);
});

test("failed monthly and annual renewals retain paid-through and exactly three days grace", async () => {
  for (const period of [30, 365]) {
    const f = fixture();
    await f.checkout();
    const paidEnd = Math.floor((Date.now() - DAY) / 1000);
    const subscription = f.subscription({ end: paidEnd });
    subscription.status = "past_due";
    subscription.items.data[0].current_period_end = paidEnd + period * 86400;
    await f.webhook(f.event("invoice.payment_failed", { customer: subscription.customer, parent: { subscription_details: { subscription: subscription.id } } }));
    const account = await f.me();
    assert.equal(account.proUntil, paidEnd * 1000);
    assert.equal(account.isPro, true);
    const row = f.db.prepare("SELECT * FROM users").get();
    assert.equal(f.accounts.entitlement(row, false, paidEnd * 1000 + 3 * DAY - 1).isPro, true);
    assert.equal(f.accounts.entitlement(row, false, paidEnd * 1000 + 3 * DAY).isPro, false);
    const invoice = f.mock.invoices.get(subscription.id)[0];
    invoice.lines.data[0].period.end = subscription.items.data[0].current_period_end;
    subscription.status = "active";
    await f.webhook(f.event("invoice.paid", { customer: subscription.customer, subscription: subscription.id }));
    assert.equal((await f.me()).proUntil, subscription.items.data[0].current_period_end * 1000);
  }
});

test("scheduled cancellation exposes its date and has no grace after that date", async () => {
  const f = fixture();
  await f.checkout();
  const subscription = f.subscription();
  subscription.cancel_at_period_end = true;
  subscription.cancel_at = subscription.items.data[0].current_period_end;
  await f.webhook(f.event("customer.subscription.updated", subscription));
  const account = await f.me();
  assert.equal(account.stripeCancelAtPeriodEnd, true);
  assert.equal(account.stripeCancelAt, subscription.cancel_at * 1000);
  const row = f.db.prepare("SELECT * FROM users").get();
  assert.equal(f.accounts.entitlement(row, false, account.stripeCancelAt).isPro, false);
});

test("failed reconciliation is retryable and checkout fails closed", async () => {
  const f = fixture();
  await f.checkout();
  const subscription = f.subscription();
  const notification = f.event("customer.subscription.updated", subscription);
  f.mock.failRead = true;
  assert.equal((await f.webhook(notification)).status, 503);
  assert.equal((await f.checkout()).status, 502);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM stripe_events").get().n, 0);
  assert.equal(f.mock.sessions.size, 1);
  f.mock.failRead = false;
  assert.equal((await f.webhook(notification)).status, 200);
  assert.equal((await f.me()).isPro, true);
  f.env.ACCOUNTS.get = () => ({ fetch() { throw new Error("Store unavailable"); } });
  assert.equal((await f.checkout()).status, 502);
  assert.equal((await f.api("/api/billing/portal", { method: "POST" })).status, 503);
});

test("portal uses Splitty's configuration and admin Pro is preserved", async () => {
  const f = fixture();
  await f.checkout();
  assert.equal((await f.api("/api/billing/portal", { method: "POST" })).status, 200);
  f.db.prepare("UPDATE users SET pro_source = 'admin', pro_until = ?").run(Date.now() + 90 * DAY);
  assert.equal((await f.checkout()).status, 409);
  const subscription = f.subscription({ status: "canceled" });
  await f.webhook(f.event("customer.subscription.deleted", subscription));
  assert.equal((await f.me()).proSource, "admin");
});

test("an expired admin grant can be replaced by a paid subscription", async () => {
  const f = fixture();
  await f.api("/api/me");
  f.db.prepare("UPDATE users SET pro_source = 'admin', pro_until = ?").run(Date.now() - DAY);
  assert.equal((await f.checkout()).status, 200);
  const subscription = f.subscription();
  await f.webhook(f.event("customer.subscription.created", subscription));
  assert.equal((await f.me()).proSource, "stripe");
  assert.equal((await f.me()).isPro, true);
});

test("expired checkout can be replaced, canceled subscriptions can subscribe again", async () => {
  const f = fixture();
  await f.checkout();
  f.mock.sessions.get("cs_1").status = "expired";
  assert.equal((await f.checkout()).status, 200);
  assert.equal(f.mock.sessions.size, 2);
  const subscription = f.subscription({ status: "canceled" });
  Object.assign(f.mock.sessions.get("cs_2"), { status: "complete", subscription: subscription.id });
  assert.equal((await f.checkout()).status, 200);
  assert.equal(f.mock.sessions.size, 3);
  assert.equal(f.mock.customers.size, 1);
});

test("account deletion waits for pending checkout and active subscription to end", async () => {
  const f = fixture();
  await f.checkout();
  assert.equal((await f.remove()).ok, false);
  const subscription = f.subscription();
  Object.assign(f.mock.sessions.get("cs_1"), { status: "complete", subscription: subscription.id });
  assert.equal((await f.remove()).ok, false);
  subscription.status = "canceled";
  assert.equal((await f.remove()).ok, true);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM billing_state").get().n, 0);
});

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name, error); }
}
globalThis.fetch = originalFetch;
console.log(`${tests.length - failed}/${tests.length} billing tests passed`);
process.exitCode = failed ? 1 : 0;
