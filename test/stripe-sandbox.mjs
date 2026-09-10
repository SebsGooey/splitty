// Real Stripe Billing lifecycle test. This is intentionally NOT part of npm test.
// Run only against the isolated test/fixtures/stripe-clock-worker.js on port 8790,
// with a Stripe CLI listener already forwarding real events to /api/stripe/webhook.
// Required environment: BASE_URL, STRIPE_SECRET_KEY (test key), STRIPE_PRICE_ID
// (existing sandbox price), SESSION_SECRET, TEST_CONTROL_TOKEN. Keep secrets out
// of shell history/source; supply them through the local test environment.
// No Checkout/Portal UI or tax-registration behavior is tested here. Automatic
// tax stays off. The fixture account clock is global: do not share this Worker
// with other tests. Its disposable local account row remains after this run.
//
// Primary references, read 2026-09-10 with the official Stripe CLI:
// https://docs.stripe.com/billing/testing
// https://docs.stripe.com/billing/testing/test-clocks/api-advanced-usage
// https://docs.stripe.com/api/invoices/pay
// https://docs.stripe.com/testing?testing-method=payment-methods
// Test-clock invoices need a subscription/customer query, and renewal collection
// occurs after the roughly one-hour draft window. Account retry/dunning settings
// and webhook delivery can affect timing; timeouts are failures, never passes.

import { createHmac, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const API_VERSION = "2026-08-26.dahlia";
const DAY = 86_400_000;
const POLL_TIMEOUT = 180_000;
class TestFailure extends Error {}
function check(condition, message) { if (!condition) throw new TestFailure(message); }
const idOf = (value) => typeof value === "string" ? value : value?.id;
const safeId = (value) => typeof value === "string" && /^(?:price|prod|clock|cus|sub|in|pm)_[A-Za-z0-9]+$/.test(value) ? value : "unavailable";
const report = (stage, fields = {}) => console.log(JSON.stringify({ stage, ...fields }));
function sandbox(object, kind) {
  check(object?.object === kind && object.livemode === false, `Expected a test-mode ${kind}; refusing to continue.`);
  return object;
}

class StripeSandboxClient {
  constructor(key, runId) { this.key = key; this.runId = runId; }
  async request(method, path, form, stage) {
    check(/^\/v1\/[A-Za-z0-9_/?=&%.-]+$/.test(path), "Unexpected Stripe API path.");
    const body = form === undefined ? undefined : new URLSearchParams(form).toString();
    // Retry an uncertain write with exactly the same key and body.
    const headers = {
      authorization: "Bearer " + this.key,
      "Stripe-Version": API_VERSION,
      ...(body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
      ...(method === "POST" ? { "Idempotency-Key": `splitty-lifecycle:${this.runId}:${stage}` } : {}),
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetch("https://api.stripe.com" + path, {
          method, headers, body, redirect: "error", signal: AbortSignal.timeout(15_000),
        });
      } catch {
        if (attempt === 2) throw new TestFailure(`Stripe ${stage} request failed; response details suppressed.`);
        await delay(1000 * (attempt + 1)); continue;
      }
      const data = await response.json().catch(() => null);
      if (response.ok) return data;
      if (method === "DELETE" && response.status === 404) return { deleted: true };
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await delay(1000 * (attempt + 1)); continue;
      }
      const code = /^[a-z0-9_]+$/.test(data?.error?.code || "") ? data.error.code : "api_error";
      throw new TestFailure(`Stripe ${stage} failed: HTTP ${response.status}, ${code}.`);
    }
  }
  get(path, stage) { return this.request("GET", path, undefined, stage); }
  post(path, form, stage) { return this.request("POST", path, form, stage); }
}

async function waitFor(stage, read, ready) {
  const deadline = Date.now() + POLL_TIMEOUT;
  let nextNotice = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= nextNotice) { report("waiting", { for: stage }); nextNotice = Date.now() + 30_000; }
    await delay(1500);
  }
  throw new TestFailure(`Timed out waiting for ${stage}. Check the real CLI webhook listener and sandbox billing settings.`);
}

async function main() {
  const { BASE_URL, STRIPE_SECRET_KEY, STRIPE_PRICE_ID, SESSION_SECRET, TEST_CONTROL_TOKEN } = process.env;
  check(BASE_URL && STRIPE_SECRET_KEY && STRIPE_PRICE_ID && SESSION_SECRET && TEST_CONTROL_TOKEN,
    "Required: BASE_URL, STRIPE_SECRET_KEY, STRIPE_PRICE_ID, SESSION_SECRET, TEST_CONTROL_TOKEN.");
  check(/^(?:sk_test_|rk_test_|rkcs_test_)[A-Za-z0-9]+$/.test(STRIPE_SECRET_KEY), "Only a Stripe test-mode key is allowed.");
  check(/^price_[A-Za-z0-9]+$/.test(STRIPE_PRICE_ID), "STRIPE_PRICE_ID must identify an existing sandbox price.");
  let base;
  try { base = new URL(BASE_URL); } catch { throw new TestFailure("BASE_URL must be a loopback HTTP origin on port 8790."); }
  check(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) && base.port === "8790" &&
    !base.username && !base.password && base.pathname === "/" && !base.search && !base.hash,
    "BASE_URL must be a loopback HTTP origin on port 8790, with no credentials, path, query or fragment.");

  const runId = randomUUID();
  const subject = "splitty-lifecycle-" + runId;
  const email = subject + "@example.test";
  const stripe = new StripeSandboxClient(STRIPE_SECRET_KEY, runId);
  let clockId = null, fixtureTouched = false, failed = false;
  function cookie() {
    const body = Buffer.from(JSON.stringify({ sub: subject, email, name: "Splitty lifecycle test", exp: Date.now() + 3_600_000 })).toString("base64url");
    return "splitty_session=" + body + "." + createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  }
  async function local(path, { method = "GET", body, authenticated = false, control = false } = {}) {
    // Only these fixture/account reads are permitted. Never fabricate webhooks
    // or call a grant/reconciliation endpoint to make an assertion pass.
    check(["/api/config", "/api/me", "/__test/account-time"].includes(path), "Unexpected local test route.");
    let response;
    try {
      response = await fetch(base.origin + path, {
        method, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { ...(authenticated ? { cookie: cookie() } : {}),
          ...(control ? { "x-test-control": TEST_CONTROL_TOKEN } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new TestFailure(`Local ${path} request failed; no redirect is permitted.`); }
    const data = await response.json().catch(() => null);
    check(response.ok && data, `Local ${path} failed with HTTP ${response.status}.`);
    return data;
  }
  async function accountTime(now) {
    const result = await local("/__test/account-time", { method: "POST", body: { now }, control: true });
    check(result.now === now, "The local test fixture did not confirm the requested entitlement time.");
  }
  async function account() {
    const data = await local("/api/me", { authenticated: true });
    check(data.user?.email === email && data.account && data.account.isAdmin === false && data.billing?.enabled === true,
      "Local account authentication/billing changed, or the test identity is an admin.");
    return data.account;
  }
  function period(subscription) {
    sandbox(subscription, "subscription");
    const item = subscription.items?.data?.find((entry) => entry.price?.id === STRIPE_PRICE_ID);
    check(item?.quantity === 1 && subscription.items.data.length === 1, "Unexpected subscription price or quantity.");
    check(Number.isSafeInteger(item.current_period_start) && Number.isSafeInteger(item.current_period_end) && item.current_period_end > item.current_period_start,
      "Stripe did not return the expected subscription item period.");
    return { start: item.current_period_start, end: item.current_period_end };
  }
  let customerId, subscriptionId;
  const subscription = async () => {
    const value = sandbox(await stripe.get("/v1/subscriptions/" + subscriptionId, "read-subscription"), "subscription");
    check(idOf(value.customer) === customerId && value.metadata?.sub === subject && value.metadata?.app === "splitty", "Subscription identity changed.");
    return value;
  };
  const invoice = async (id) => {
    check(/^in_[A-Za-z0-9]+$/.test(id || ""), "Expected a subscription invoice ID.");
    const value = sandbox(await stripe.get("/v1/invoices/" + id, "read-invoice"), "invoice");
    check(idOf(value.customer) === customerId && idOf(value.parent?.subscription_details?.subscription || value.subscription) === subscriptionId,
      "Invoice does not belong to the runner subscription.");
    check(!value.lines?.has_more, "Unexpected invoice pagination for a one-item test subscription.");
    return value;
  };
  function invoicePeriod(value, expected, paid) {
    const lines = value.lines?.data?.filter((line) => idOf(line.pricing?.price_details?.price || line.price) === STRIPE_PRICE_ID &&
      (line.parent?.subscription_item_details || line.type === "subscription" || line.subscription_item)) || [];
    check(lines.length === 1 && lines[0].period?.start === expected.start && lines[0].period?.end === expected.end,
      "Invoice recurring line does not match the expected subscription period.");
    check(value.currency === "usd" && value.total === 299 && value.amount_due === 299,
      "The test invoice must contain exactly the launch price, without discounts, credits or added tax.");
    if (paid) check(value.status === "paid" && value.amount_paid === 299 && value.amount_remaining === 0,
      "A matching recurring invoice has not actually been paid.");
  }
  async function paidHistory(expectedPeriods) {
    const values = await stripe.get("/v1/invoices?" + new URLSearchParams({ subscription: subscriptionId, status: "paid", limit: "100" }), "read-paid-invoices");
    check(Array.isArray(values?.data) && !values.has_more && values.data.length === expectedPeriods.length,
      "Paid invoice history contains an unexpected number of periods.");
    const periods = values.data.map((value) => {
      sandbox(value, "invoice");
      check(idOf(value.customer) === customerId && idOf(value.parent?.subscription_details?.subscription || value.subscription) === subscriptionId,
        "Paid invoice history contains an unrelated invoice.");
      const expected = expectedPeriods.find((entry) => value.lines?.data?.some((line) =>
        line.period?.start === entry.start && line.period?.end === entry.end));
      check(expected, "Paid invoice history contains an unexpected billing period.");
      invoicePeriod(value, expected, true);
      return expected.start;
    });
    check(new Set(periods).size === expectedPeriods.length, "Paid invoice history contains duplicate periods.");
  }
  async function advance(seconds, label) {
    await stripe.post("/v1/test_helpers/test_clocks/" + clockId + "/advance", { frozen_time: String(seconds) }, label);
    await waitFor(label + " clock ready", async () => sandbox(await stripe.get("/v1/test_helpers/test_clocks/" + clockId, "read-clock"), "test_helpers.test_clock"),
      (value) => value.status === "ready" && value.frozen_time === seconds);
    await accountTime(seconds * 1000);
  }
  async function setPaymentMethod(id, label) {
    sandbox(await stripe.post("/v1/customers/" + customerId, { "invoice_settings[default_payment_method]": id }, label + "-customer"), "customer");
    sandbox(await stripe.post("/v1/subscriptions/" + subscriptionId, { default_payment_method: id }, label + "-subscription"), "subscription");
  }
  async function paidAccount(end, label) {
    return waitFor(label, account, (value) => value.isPro === true && value.canScan === true && value.proSource === "stripe" &&
      value.stripeStatus === "active" && value.proUntil === end * 1000);
  }

  report("starting", { run: runId, apiVersion: API_VERSION });
  try {
    const config = await local("/api/config");
    check(config.authRequired === true && config.authMisconfigured === false && config.billing?.enabled === true,
      "The isolated Worker must require configured authentication and have sandbox billing enabled.");
    const price = sandbox(await stripe.get("/v1/prices/" + STRIPE_PRICE_ID + "?expand%5B%5D=product", "read-price"), "price");
    sandbox(price.product, "product");
    check(price.active === true && price.unit_amount === 299 && price.currency === "usd" && price.recurring?.interval === "month" && price.recurring.interval_count === 1,
      "Expected the existing active sandbox launch price: USD 2.99 each month.");
    const start = Math.floor(Date.now() / 1000);
    // This control route is also proof that we reached the test-only entrypoint.
    fixtureTouched = true;
    await accountTime(start * 1000);
    const initial = await account();
    check(initial.isPro === false && initial.canScan === false && !initial.hasStripeCustomer, "The fresh test identity must start Free and unbound.");
    const clock = sandbox(await stripe.post("/v1/test_helpers/test_clocks", { frozen_time: String(start), name: "Splitty lifecycle " + runId }, "create-clock"), "test_helpers.test_clock");
    check(/^clock_[A-Za-z0-9]+$/.test(clock.id || ""), "Stripe returned an invalid test clock ID.");
    clockId = clock.id;
    const customer = sandbox(await stripe.post("/v1/customers", {
      test_clock: clockId, "metadata[sub]": subject, "metadata[app]": "splitty",
    }, "create-customer"), "customer");
    customerId = customer.id;
    check(idOf(customer.test_clock) === clockId, "Customer is not attached to the runner's test clock.");
    const visa = sandbox(await stripe.post("/v1/payment_methods/pm_card_visa/attach", { customer: customerId }, "attach-visa"), "payment_method");
    check(idOf(visa.customer) === customerId, "Test Visa payment method did not attach to the runner customer.");
    sandbox(await stripe.post("/v1/customers/" + customerId, { "invoice_settings[default_payment_method]": visa.id }, "set-initial-default"), "customer");
    const created = sandbox(await stripe.post("/v1/subscriptions", {
      customer: customerId, "items[0][price]": STRIPE_PRICE_ID, default_payment_method: visa.id,
      payment_behavior: "error_if_incomplete", "automatic_tax[enabled]": "false",
      "metadata[sub]": subject, "metadata[app]": "splitty",
    }, "create-subscription"), "subscription");
    subscriptionId = created.id;
    const first = period(created);
    const firstInvoice = await waitFor("initial invoice paid", () => invoice(idOf(created.latest_invoice)), (value) => value.status === "paid");
    invoicePeriod(firstInvoice, first, true);
    await paidAccount(first.end, "initial webhook-granted Pro");
    report("initial-payment-and-Pro", { clock: safeId(clockId), customer: safeId(customerId), subscription: safeId(subscriptionId), invoice: safeId(firstInvoice.id), paidThrough: first.end });

    await advance(first.end + 3601, "advance-renewal");
    const renewed = await waitFor("renewal subscription period", subscription, (value) => value.status === "active" && period(value).start === first.end);
    const second = period(renewed);
    const renewalInvoice = await waitFor("renewal invoice paid", () => invoice(idOf(renewed.latest_invoice)), (value) => value.status === "paid");
    check(renewalInvoice.id !== firstInvoice.id && second.end > first.end, "Renewal did not create a new paid period.");
    invoicePeriod(renewalInvoice, second, true);
    await paidAccount(second.end, "renewal webhook extends Pro");
    await paidHistory([first, second]);
    report("renewal-paid-and-extended", { invoice: safeId(renewalInvoice.id), paidThrough: second.end });

    const failing = sandbox(await stripe.post("/v1/payment_methods/pm_card_chargeCustomerFail/attach", { customer: customerId }, "attach-failing-card"), "payment_method");
    check(idOf(failing.customer) === customerId, "Failing test payment method did not attach to the runner customer.");
    await setPaymentMethod(failing.id, "set-failing-default");
    await advance(second.end + 3601, "advance-failed-renewal");
    const pastDue = await waitFor("past_due after failed renewal", subscription, (value) => value.status === "past_due" && period(value).start === second.end);
    const third = period(pastDue);
    const failedInvoice = await invoice(idOf(pastDue.latest_invoice));
    invoicePeriod(failedInvoice, third, false);
    check(failedInvoice.status === "open" && failedInvoice.attempted === true && failedInvoice.amount_paid === 0 && failedInvoice.amount_remaining === 299,
      "Expected an attempted, unpaid renewal invoice.");
    const grace = await waitFor("failed renewal webhook retains only prior paid-through", account,
      (value) => value.stripeStatus === "past_due" && value.isPro === true && value.proUntil === second.end * 1000);
    check(grace.canScan === true && third.end > second.end, "Failed renewal did not remain in the bounded prior-payment grace period.");
    await paidHistory([first, second]);
    await accountTime(second.end * 1000 + 3 * DAY - 1);
    check((await account()).isPro === true, "Pro grace ended before the three-day boundary.");
    await accountTime(second.end * 1000 + 3 * DAY);
    const expiredGrace = await account();
    check(expiredGrace.isPro === false && expiredGrace.canScan === false && expiredGrace.proUntil === null && expiredGrace.stripeStatus === "past_due",
      "Pro or scanning survived the exact three-day grace boundary.");
    report("failed-renewal-and-grace-expiry", { invoice: safeId(failedInvoice.id), priorPaidThrough: second.end, unpaidPeriodEnd: third.end });

    await setPaymentMethod(visa.id, "restore-visa");
    const recoveredInvoice = sandbox(await stripe.post("/v1/invoices/" + failedInvoice.id + "/pay", { payment_method: visa.id }, "recover-invoice"), "invoice");
    invoicePeriod(recoveredInvoice, third, true);
    await waitFor("recovered subscription active", subscription, (value) => value.status === "active");
    await paidAccount(third.end, "recovery webhook restores Pro");
    await paidHistory([first, second, third]);
    report("payment-recovered-and-Pro-restored", { invoice: safeId(recoveredInvoice.id), paidThrough: third.end });

    const canceling = sandbox(await stripe.post("/v1/subscriptions/" + subscriptionId, { cancel_at_period_end: "true" }, "schedule-cancellation"), "subscription");
    check(canceling.cancel_at_period_end === true && period(canceling).end === third.end && canceling.cancel_at === third.end,
      "Cancellation was not scheduled at the paid period end.");
    await accountTime(third.end * 1000 - 1);
    const beforeCancel = await waitFor("cancellation webhook preserves paid access until end", account,
      (value) => value.stripeCancelAtPeriodEnd === true && value.stripeCancelAt === third.end * 1000 && value.isPro === true);
    check(beforeCancel.proUntil === third.end * 1000 && beforeCancel.canScan === true, "Cancellation removed paid access early.");
    await accountTime(third.end * 1000);
    const atCancel = await account();
    check(atCancel.isPro === false && atCancel.canScan === false && atCancel.stripeStatus === "active", "Scheduled cancellation incorrectly received retry grace.");
    await advance(third.end + 3601, "advance-cancellation");
    await waitFor("Stripe subscription canceled", subscription, (value) => value.status === "canceled");
    await waitFor("cancellation webhook removes Pro", account, (value) => value.stripeStatus === "canceled" && value.isPro === false && value.canScan === false);
    await paidHistory([first, second, third]);
    report("canceled-with-no-grace", { subscription: safeId(subscriptionId), endedAt: third.end });
    report("lifecycle-assertions-passed", { scope: "Real sandbox invoices, subscription events, and local Worker entitlements; excludes Checkout/Portal UI and tax." });
  } catch (error) {
    failed = true;
    report("failed", { reason: error instanceof TestFailure ? error.message : "Unexpected runner error; response details suppressed." });
  } finally {
    // Cleanup is limited to this run's newly created clock. Stripe deletes its
    // attached customers and cancels their subscriptions. Never list-and-delete.
    if (clockId) {
      try {
        const removed = await stripe.request("DELETE", "/v1/test_helpers/test_clocks/" + clockId, undefined, "cleanup-clock");
        check(removed?.deleted === true, "Stripe did not confirm test clock deletion.");
        report("cleaned-test-clock", { clock: safeId(clockId) });
      } catch { failed = true; report("cleanup-failed", { clock: safeId(clockId), action: "Delete only this runner-created test clock after checking its state." }); }
    }
    if (fixtureTouched) {
      try { await accountTime(null); }
      catch { failed = true; report("cleanup-failed", { action: "Reset the isolated fixture entitlement clock before reusing it." }); }
    }
  }
  if (failed) process.exitCode = 1;
  else report("passed", { cleanup: "Runner-created test clock deleted and local entitlement clock reset." });
}

await main().catch((error) => {
  report("preflight-blocked", { reason: error instanceof TestFailure ? error.message : "Unexpected runner setup error; details suppressed." });
  process.exitCode = 1;
});
