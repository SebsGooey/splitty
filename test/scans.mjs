// Receipt quota regression tests. Real Accounts logic runs against in-memory
// SQLite; every external request is intercepted. No credentials or spend.
// Run with Node 24+: node test/scans.mjs
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import worker, { Accounts } from "../src/worker.js";

const DAY = 86400_000;
const PHOTO = { media_type: "image/jpeg", data: Buffer.from("private receipt photo ".repeat(20)).toString("base64") };
const DRAFT = { restaurant: "Private Test Diner", items: [{ name: "Lunch", priceCents: 1299 }], subtotalCents: 1299, taxCents: 100, warnings: [] };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const originalFetch = globalThis.fetch;
const originalInfo = console.info;
const databases = [];
const forbidNetwork = async () => { throw new Error("Unexpected network request: scan tests never access the network"); };
globalThis.fetch = forbidNetwork;

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
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
    GOOGLE_CLIENT_ID: "scan-test-client", SESSION_SECRET: "scan-test-session-secret",
    ANTHROPIC_API_KEY: "scan-test-placeholder", PARSE_MODEL: "claude-opus-5", ADMIN_EMAILS: "admin@example.test",
  };
  const accounts = new Accounts(ctx, env);
  const mock = { upstream: [], meter: [], logs: [], accountFailure: null, meterAllowed: true, meterFails: false, meterDelay: false, outcome: "success", onFetch: null };
  env.ACCOUNTS = { idFromName: () => "global", get: () => ({ fetch: async (...args) => {
    const request = new Request(...args);
    if (mock.accountFailure === "all" || mock.accountFailure === new URL(request.url).pathname) throw new Error("Mock accounts unavailable");
    return accounts.fetch(request);
  } }) };
  env.METER = { idFromName: () => "global", get: () => ({ fetch: async (...args) => {
    if (mock.meterFails) throw new Error("Mock meter unavailable");
    const body = await new Request(...args).json();
    assert.equal(body.kind, "parse");
    mock.meter.push(body);
    if (mock.meterDelay) await new Promise(setImmediate);
    return Response.json({ ok: mock.meterAllowed, message: "Daily scan limit reached" });
  } }) };
  console.info = (...args) => mock.logs.push(args);
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(String(input), "https://api.anthropic.com/v1/messages", "Only the mocked receipt API may be called");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["x-api-key"], "scan-test-placeholder");
    const body = JSON.parse(init.body);
    assert.equal(body.messages[0].content[0].source.data, PHOTO.data);
    mock.upstream.push(body);
    if (mock.onFetch) mock.onFetch();
    if (mock.outcome === "upstream_unavailable") throw new Error("Mock connection reset");
    if (mock.outcome === "upstream_error") return Response.json({ error: { message: "Mock service unavailable" } }, { status: 503 });
    if (mock.outcome === "invalid_response") return new Response("not JSON", { status: 200 });
    return Response.json({
      model: env.PARSE_MODEL, stop_reason: ["refusal", "max_tokens"].includes(mock.outcome) ? mock.outcome : "end_turn",
      usage: { input_tokens: 120, output_tokens: 45 },
      content: [{ type: "text", text: mock.outcome === "invalid_draft" ? "not JSON" : JSON.stringify(DRAFT) }],
    });
  };
  const identity = (sub) => ({ sub, email: sub + "@example.test", name: "Private Test User" });
  const cookie = (sub) => {
    const body = Buffer.from(JSON.stringify({ ...identity(sub), exp: Date.now() + DAY })).toString("base64url");
    return "splitty_session=" + body + "." + createHmac("sha256", env.SESSION_SECRET).update(body).digest("base64url");
  };
  const api = async (path, { sub = "buyer", method = "GET", body, raw, headers = {} } = {}) => {
    const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
    const requestHeaders = new Headers({ ...(sub ? { cookie: cookie(sub) } : {}), ...(payload !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}) });
    for (const [name, value] of Object.entries(headers)) value === null ? requestHeaders.delete(name) : requestHeaders.set(name, value);
    const response = await worker.fetch(new Request("https://splitty.test" + path, { method, headers: requestHeaders, ...(payload !== undefined ? { body: payload } : {}) }), env);
    return { status: response.status, data: await response.json() };
  };
  const me = async (sub = "buyer") => (await api("/api/me", { sub })).data.account;
  const direct = async (path, body) => (await accounts.fetch(new Request("https://do" + path, { method: "POST", body: JSON.stringify(body) }))).json();
  const grant = async (sub = "buyer") => {
    await me(sub);
    assert.equal((await direct("/grant", { sub, until: Date.now() + 30 * DAY })).ok, true);
  };
  const used = (value, sub = "buyer") => db.prepare("UPDATE users SET scans_month = ?, scans_total = ? WHERE sub = ?").run(value, value, sub);
  const row = (sub = "buyer") => db.prepare("SELECT * FROM users WHERE sub = ?").get(sub);
  const scan = (options = {}) => api("/api/parse", { method: "POST", body: PHOTO, ...options });
  return { env, accounts, mock, db, api, me, grant, used, row, scan, direct, identity };
}

test("public scan allowance is zero for Free, 30 for Pro, and unlimited for admins", async () => {
  const f = fixture();
  assert.equal((await f.api("/api/config")).data.billing.proScansPerMonth, 30);
  const free = await f.me();
  assert.deepEqual([free.scansUsed, free.scansLimit, free.scansLeft, free.canScan], [0, 0, 0, false]);
  await f.grant();
  const pro = await f.me();
  assert.deepEqual([pro.scansUsed, pro.scansLimit, pro.scansLeft, pro.canScan], [0, 30, 30, true]);
  const admin = await f.me("admin");
  assert.deepEqual([admin.scansUsed, admin.scansLimit, admin.scansLeft, admin.canScan], [0, null, null, true]);
  assert.equal(f.mock.upstream.length, 0);
});

test("a successful scan reserves one attempt before upstream spend and never counts twice", async () => {
  const f = fixture();
  await f.grant();
  f.mock.onFetch = () => assert.equal(f.row().scans_month, 1, "reservation must precede external processing");
  const response = await f.scan();
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.draft, DRAFT);
  const account = await f.me();
  assert.deepEqual([account.scansUsed, account.scansLeft], [1, 29]);
  assert.equal(f.row().scans_total, 1);
});

test("invalid input never reaches the meter or consumes monthly scans", async () => {
  const f = fixture();
  await f.grant();
  for (const [options, status] of [
    [{ headers: { "content-length": null } }, 411],
    [{ headers: { "content-length": "NaN" } }, 411],
    [{ headers: { "content-length": "8000001" } }, 413],
    [{ raw: "{broken" }, 400],
    [{ body: null }, 400],
    [{ body: { media_type: "text/plain", data: PHOTO.data } }, 400],
    [{ body: { ...PHOTO, data: "x".repeat(99) } }, 400],
  ]) assert.equal((await f.scan(options)).status, status);
  assert.equal(f.row().scans_month, 0);
  assert.equal(f.mock.meter.length, 0);
  assert.equal(f.mock.upstream.length, 0);
});

test("a denied or unavailable daily meter does not use a monthly attempt", async () => {
  const f = fixture();
  await f.grant();
  f.mock.meterAllowed = false;
  assert.equal((await f.scan()).status, 429);
  f.mock.meterFails = true;
  assert.equal((await f.scan()).status, 429);
  assert.equal(f.row().scans_month, 0);
  assert.equal(f.mock.upstream.length, 0);
});

for (const [outcome, status] of [
  ["upstream_unavailable", 502], ["upstream_error", 502], ["invalid_response", 502],
  ["refusal", 422], ["max_tokens", 422], ["invalid_draft", 422],
]) test("failed processing still consumes exactly one attempt: " + outcome, async () => {
  const f = fixture();
  await f.grant();
  f.mock.outcome = outcome;
  assert.equal((await f.scan()).status, status);
  assert.equal(f.row().scans_month, 1);
  assert.equal(f.row().scans_total, 1);
  assert.equal((await f.me()).scansLeft, 29);
  assert.equal(f.mock.upstream.length, 1);
  assert.equal(JSON.parse(f.mock.logs[0][0]).outcome, outcome);
});

test("12 concurrent scans with one attempt left allow only one upstream request", async () => {
  const f = fixture();
  await f.grant();
  f.used(29);
  f.mock.meterDelay = true; // All callers pass preflight before reservations.
  f.mock.onFetch = () => assert.equal(f.row().scans_month, 30);
  const results = await Promise.all(Array.from({ length: 12 }, () => f.scan()));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 429).length, 11);
  assert.equal(f.mock.meter.length, 12, "exercise the reservation race after initial entitlement reads");
  assert.equal(f.mock.upstream.length, 1);
  assert.equal(f.row().scans_month, 30);
  for (const response of results.filter((r) => r.status === 429)) {
    assert.equal(response.data.scanQuota, true);
    assert.equal(response.data.upgrade, undefined);
    assert.equal(response.data.account.scansLeft, 0);
  }
});

test("monthly exhaustion blocks scanning but permits unlimited manual bills", async () => {
  const f = fixture();
  await f.grant();
  f.used(30);
  const response = await f.scan();
  assert.equal(response.status, 429);
  assert.equal(response.data.scanQuota, true);
  assert.equal(response.data.upgrade, undefined);
  assert.match(response.data.error, /manually/);
  assert.equal((await f.me()).canScan, false);
  for (let i = 0; i < 4; i++) {
    const manual = await f.direct("/consume", { ...f.identity("buyer"), kind: "bill", isAdmin: false });
    assert.equal(manual.ok, true);
    assert.equal(manual.entitlement.billsLimit, null);
  }
  assert.equal(f.row().bills_month, 4);
  assert.equal(f.row().scans_month, 30);
  assert.equal(f.mock.upstream.length, 0);
});

test("calendar month rollover resets attempts at midnight UTC without rollover credit", async () => {
  const f = fixture();
  await f.grant();
  // Use an explicit UTC boundary rather than the machine's local time zone.
  const boundary = Date.UTC(2026, 9, 1);
  f.db.prepare("UPDATE users SET month_key = ?, scans_month = 30, scans_total = 47, pro_until = ? WHERE sub = ?").run("2026-09", boundary + 90 * DAY, "buyer");
  const before = f.accounts.touch("buyer", "buyer@example.test", "Buyer", boundary - 1);
  assert.equal(f.accounts.entitlement(before, false, boundary - 1).scansLeft, 0);
  const after = f.accounts.touch("buyer", "buyer@example.test", "Buyer", boundary);
  assert.equal(after.month_key, "2026-10");
  assert.deepEqual([after.scans_month, after.scans_total], [0, 47]);
  assert.equal(f.accounts.entitlement(after, false, boundary).scansLeft, 30);
  f.db.prepare("UPDATE users SET scans_month = 7 WHERE sub = ?").run("buyer");
  const next = f.accounts.touch("buyer", "buyer@example.test", "Buyer", Date.UTC(2026, 10, 1));
  assert.equal(next.scans_month, 0, "unused attempts do not roll over");
  assert.equal(f.accounts.entitlement(next, false, Date.UTC(2026, 10, 1)).scansLeft, 30);
});

test("admin accounts remain unlimited after 30 attempts", async () => {
  const f = fixture();
  await f.me("admin");
  f.used(30, "admin");
  assert.equal((await f.scan({ sub: "admin" })).status, 200);
  const account = await f.me("admin");
  assert.deepEqual([account.scansUsed, account.scansLimit, account.scansLeft, account.canScan], [31, null, null, true]);
});

test("Free and anonymous accounts never reach upstream; no-auth mode keeps its existing behavior", async () => {
  const f = fixture();
  const free = await f.scan();
  assert.equal(free.status, 402);
  assert.equal(free.data.upgrade, true);
  assert.equal(free.data.scanQuota, undefined);
  assert.equal((await f.scan({ sub: null })).status, 401);
  assert.equal(f.mock.upstream.length, 0);
  delete f.env.GOOGLE_CLIENT_ID;
  delete f.env.SESSION_SECRET;
  assert.equal((await f.scan({ sub: null })).status, 200);
  assert.equal(f.mock.upstream.length, 1);
  assert.equal(f.row().scans_month, 0, "no-auth scanning must not mutate a signed-in account");
});

test("account read or reservation failure closes the scan gate before upstream spend", async () => {
  const f = fixture();
  await f.grant();
  f.mock.accountFailure = "all";
  assert.equal((await f.scan()).status, 503);
  assert.equal((await f.scan({ sub: "admin" })).status, 503, "admins also fail closed during account-store failure");
  f.mock.accountFailure = "/consume";
  assert.equal((await f.scan()).status, 503);
  assert.equal(f.row().scans_month, 0);
  assert.equal(f.mock.upstream.length, 0);
});

test("usage telemetry contains model and tokens, never photo or account data", async () => {
  const f = fixture();
  await f.grant();
  assert.equal((await f.scan()).status, 200);
  assert.equal(f.mock.logs.length, 1);
  assert.equal(f.mock.logs[0].length, 1);
  const log = JSON.parse(f.mock.logs[0][0]);
  assert.deepEqual(log, { event: "receipt_scan", model: "claude-opus-5", input_tokens: 120, output_tokens: 45, outcome: "success" });
  const text = JSON.stringify(f.mock.logs);
  for (const privateValue of [PHOTO.data, "buyer", "@example.test", "Private Test User", DRAFT.restaurant]) {
    assert.equal(text.includes(privateValue), false, "telemetry must not contain " + privateValue.slice(0, 30));
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name, error); }
  finally {
    globalThis.fetch = forbidNetwork;
    console.info = originalInfo;
    while (databases.length) databases.pop().close();
  }
}
globalThis.fetch = originalFetch;
console.log(`${tests.length - failed}/${tests.length} scan tests passed`);
process.exitCode = failed ? 1 : 0;
