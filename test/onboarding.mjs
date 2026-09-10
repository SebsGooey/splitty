// Offline onboarding regression tests: execute the shipped browser scripts,
// exercise their handlers, and compare monetary results with fixed expectations.
// No server, credentials, third-party requests or persistent browser storage.
// Run: node test/onboarding.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadPage } from "./dom-harness.mjs";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const plain = (value) => JSON.parse(JSON.stringify(value));
const visible = (element) => {
  for (let current = element; current; current = current.parentElement) {
    if (current.hidden || current.classList.contains("hidden")) return false;
  }
  return true;
};
const assertConserved = (totals, expected = 7678) => {
  const allocated = totals.perPerson.reduce((sum, row) => sum + row.totalCents, 0);
  assert.equal(allocated + totals.unclaimed + totals.unclaimedTax + totals.unclaimedTip, expected);
  for (const row of totals.perPerson) {
    for (const key of ["shareCents", "taxCents", "tipCents", "totalCents"]) assert.ok(Number.isInteger(row[key]) && row[key] >= 0, key + " must remain nonnegative integer cents");
  }
};
const person = (page, id) => page.element("demoPeople").querySelector(`[data-person-id="${id}"]`);
const item = (page, id) => page.element("demoItems").querySelector(`[data-item-id="${id}"]`);

test("a sample is available before sign-in without changing the Free or Pro plans", () => {
  const home = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(home.indexOf('id="sampleDemo"') > 0);
  assert.ok(home.indexOf('id="sampleDemo"') < home.indexOf('id="authCard"'));
  assert.match(home.slice(home.indexOf('id="sampleDemo"'), home.indexOf('id="planSummary"')), /href="\/demo(?:\.html)?"/);
  assert.match(home, /3 manual bills per calendar month/);
  assert.match(home, /\$2\.99 \/ month/);
  assert.match(home, /30<\/span> receipt scan attempts per calendar month/);
});

test("fictional sample starts with all 7678 cents unclaimed and Alex selected", () => {
  const page = loadPage("demo.html");
  const sample = page.context.createDemoBill();
  assert.deepEqual(plain(sample.people.map((entry) => entry.id)), ["alex", "sam", "jules"]);
  assert.equal(sample.items.reduce((sum, entry) => sum + entry.priceCents, 0), 5998);
  assert.equal(sample.taxCents, 480);
  const totals = page.context.computeTotals(sample);
  assert.equal(totals.tipTotal, 1200);
  assertConserved(totals);
  assert.equal(totals.unclaimed + totals.unclaimedTax + totals.unclaimedTip, 7678);
  assert.equal(page.element("demoActiveName").textContent, "Alex");
  assert.match(page.element("demoActiveAmount").textContent, /\$0\.00/);
  assert.match(page.element("demoUnclaimedAmount").textContent, /\$76\.78/);
  assert.equal(person(page, "alex").getAttribute("aria-pressed"), "true");
  assert.ok(page.element("demoItems").querySelectorAll("button").every((button) => button.getAttribute("aria-pressed") === "false"));
  assert.deepEqual(page.effects, []);
});

test("setting or removing the same shared claim twice is idempotent", () => {
  const page = loadPage("demo.html");
  const bill = page.context.createDemoBill();
  const claim = page.context.setDemoClaim;
  assert.equal(claim(bill, "alex", "fries", true), true);
  assert.equal(claim(bill, "alex", "fries", true), false);
  assert.equal(claim(bill, "sam", "fries", true), true);
  assert.equal(claim(bill, "sam", "fries", true), false);
  assert.deepEqual(plain(bill.claims.fries), { alex: 1, sam: 1 });
  let totals = page.context.computeTotals(bill);
  assert.deepEqual(plain(totals.perPerson.map((row) => row.shareCents)), [450, 449, 0]);
  assertConserved(totals);
  assert.equal(claim(bill, "alex", "fries", false), true);
  assert.equal(claim(bill, "alex", "fries", false), false);
  totals = page.context.computeTotals(bill);
  assert.deepEqual(plain(totals.perPerson.map((row) => row.shareCents)), [0, 899, 0]);
  assertConserved(totals);
});

test("every combination of shared fries conserves the exact bill total", () => {
  const page = loadPage("demo.html");
  for (let mask = 0; mask < 8; mask++) {
    const bill = page.context.createDemoBill();
    for (const [index, id] of ["alex", "sam", "jules"].entries()) page.context.setDemoClaim(bill, id, "fries", Boolean(mask & (1 << index)));
    const totals = page.context.computeTotals(bill);
    assertConserved(totals);
    assert.equal(totals.perPerson.reduce((sum, row) => sum + row.shareCents, 0), mask ? 899 : 0);
    if (mask === 7) assert.deepEqual(plain(totals.perPerson.map((row) => row.shareCents)), [300, 300, 299]);
  }
});

test("a fully claimed sample allocates every tax and tip cent", () => {
  const page = loadPage("demo.html"), bill = page.context.createDemoBill();
  for (const [id, ids] of Object.entries({ alex: ["pasta", "fries", "lemonade"], sam: ["tacos", "fries", "lemonade"], jules: ["bowl", "lemonade"] })) {
    for (const itemId of ids) page.context.setDemoClaim(bill, id, itemId, true);
  }
  const totals = page.context.computeTotals(bill);
  assert.equal(totals.unclaimed, 0);
  assert.equal(totals.unclaimedTax, 0);
  assert.equal(totals.unclaimedTip, 0);
  assert.deepEqual(plain(totals.perPerson.map((row) => row.shareCents)), [2283, 2132, 1583]);
  // Tax fractions are .701/.617/.682; the spare cents go to Alex/Jules.
  // Tip fractions are .752/.542/.706; those spare cents also go to Alex/Jules.
  assert.deepEqual(plain(totals.perPerson.map((row) => [row.taxCents, row.tipCents])), [[183, 457], [170, 426], [127, 317]]);
  assert.deepEqual(plain(totals.perPerson.map((row) => row.totalCents)), [2923, 2728, 2027]);
  assertConserved(totals);
});

test("switching people preserves claims, updates accessible state, and reset restores exploration", () => {
  const page = loadPage("demo.html");
  item(page, "pasta").click();
  const pastaAmount = page.element("demoActiveAmount").textContent;
  assert.notEqual(pastaAmount, "$0.00");
  person(page, "sam").click();
  assert.equal(page.element("demoActiveName").textContent, "Sam");
  assert.equal(item(page, "pasta").getAttribute("aria-pressed"), "false");
  item(page, "fries").click();
  person(page, "alex").click();
  assert.equal(item(page, "pasta").getAttribute("aria-pressed"), "true");
  assert.equal(page.element("demoActiveAmount").textContent, pastaAmount);
  item(page, "fries").click();
  assert.equal(item(page, "fries").getAttribute("aria-pressed"), "true");
  person(page, "sam").click();
  assert.equal(item(page, "fries").getAttribute("aria-pressed"), "true");
  // Sam claimed first, so Sam receives the odd item cent: 450 + 36 + 90.
  assert.equal(page.element("demoActiveAmount").textContent, "$5.76");
  person(page, "jules").click();
  assert.equal(item(page, "fries").getAttribute("aria-pressed"), "false");
  const reset = page.element("demoReset"); reset.focus(); reset.click();
  assert.equal(page.document.activeElement, reset);
  assert.equal(page.element("demoActiveName").textContent, "Alex");
  assert.equal(person(page, "alex").getAttribute("aria-pressed"), "true");
  assert.match(page.element("demoActiveAmount").textContent, /\$0\.00/);
  assert.match(page.element("demoUnclaimedAmount").textContent, /\$76\.78/);
  assert.ok(page.element("demoItems").querySelectorAll("button").every((button) => button.getAttribute("aria-pressed") === "false"));
  assert.deepEqual(page.effects, [], "exploration must not access storage, APIs, tracking or payment services");
});

test("demo claim buttons undo cleanly and announce the selected person's action", () => {
  const page = loadPage("demo.html");
  const button = item(page, "pasta"); button.focus(); button.click();
  assert.equal(page.document.activeElement, button, "render must preserve the focused button");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.match(button.getAttribute("aria-label"), /Remove Alex/);
  assert.match(page.element("demoAnnouncement").textContent, /Alex claimed Rigatoni/);
  button.click();
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.match(button.getAttribute("aria-label"), /Claim for Alex/);
  assert.equal(page.element("demoActiveAmount").textContent, "$0.00");
  assert.equal(page.element("demoUnclaimedAmount").textContent, "$76.78");
  assert.match(page.element("demoAnnouncement").textContent, /removed their claim/);
  assert.equal(page.element("demoAnnouncement").getAttribute("aria-live"), "polite");
  assert.deepEqual(page.effects, []);
});

test("separate demo visits and resets never carry over someone else's sample claims", () => {
  const first = loadPage("demo.html"), second = loadPage("demo.html");
  item(first, "pasta").click();
  assert.equal(item(second, "pasta").getAttribute("aria-pressed"), "false");
  const sample = first.context.createDemoBill();
  first.context.setDemoClaim(sample, "alex", "pasta", true);
  assert.deepEqual(plain(first.context.createDemoBill().claims), {});
  assert.deepEqual([...first.effects, ...second.effects], []);
});

const billId = "a".repeat(22);
async function billPage({ identity = "guest", creator = false, paid = {}, mutate } = {}) {
  const bill = {
    id: billId, restaurant: "Fictional Table", version: 1, locked: false, creatorPersonId: "host", pay: {}, paid,
    items: [{ id: "hostItem", name: "Host lunch", priceCents: 1000 }, { id: "guestItem", name: "Guest lunch", priceCents: 1001 }, { id: "otherItem", name: "Other lunch", priceCents: 999 }],
    people: [{ id: "host", name: "Host", color: "#111" }, { id: "guest", name: "Guest", color: "#222" }, { id: "other", name: "Other", color: "#333" }],
    claims: { hostItem: { host: 1 }, guestItem: { guest: 1 }, otherItem: { other: 1 } }, taxCents: 300, tip: { mode: "percent", value: 10 },
  };
  mutate?.(bill);
  const storage = {};
  if (identity) storage["splitty-me-" + billId] = JSON.stringify({ personId: identity, token: "private-person-token" });
  if (creator) storage["splitty-creator-" + billId] = "private-creator-token";
  const page = loadPage("bill.html", { storage, allowBillBootstrap: true });
  await new Promise(setImmediate);
  assert.equal(page.sockets.length, 1, "one mocked bill socket starts");
  const socket = page.sockets[0]; socket.receive({ type: "state", bill });
  return { ...page, bill, socket, update(mutator = () => {}) { mutator(bill); bill.version++; socket.receive({ type: "state", bill }); }, invite: () => page.element("nextBillInvite") };
}

test("a guest invitation appears only after the guest's own paid acknowledgement", async () => {
  const page = await billPage();
  assert.equal(visible(page.invite()), false);
  page.element("personTotals").querySelector(".paidbtn").click();
  assert.equal(visible(page.invite()), false, "sending intent is not a server acknowledgement");
  assert.deepEqual(JSON.parse(page.socket.sent.at(-1)), { type: "set_paid", personId: "guest", paid: true, expectedVersion: 1, token: "private-person-token" });
  page.update((bill) => { bill.paid.guest = Date.now(); });
  assert.equal(visible(page.invite()), true);
  assert.match(page.invite().textContent, /marked as paid/i);
  const link = page.element("nextBillLink");
  assert.equal(link.getAttribute("href"), "/", "no bill id, receipt details, tokens or tracking query in the new-host link");
  assert.equal(link.getAttribute("rel"), "noreferrer");
  assert.match(page.invite().textContent, /3 free manual bills/);
  page.element("personTotals").querySelector(".paidbtn").click();
  assert.deepEqual(JSON.parse(page.socket.sent.at(-1)), { type: "set_paid", personId: "guest", paid: false, token: "private-person-token" });
  page.update((bill) => { delete bill.paid.guest; });
  assert.equal(visible(page.invite()), false, "undo paid hides the invitation");
  assert.equal(visible(page.element("paidResetNotice")), false, "ordinary undo must not imply bill amounts changed");
});

test("a retained paid button sends the bill version it displayed", async () => {
  const page = await billPage();
  const stale = page.element("personTotals").querySelector(".paidbtn");
  page.update((bill) => { bill.items[1].priceCents += 100; });
  stale.click();
  assert.equal(JSON.parse(page.socket.sent.at(-1)).expectedVersion, 1, "a late intent must not claim it saw the newer amount");
  page.element("personTotals").querySelector(".paidbtn").click();
  assert.equal(JSON.parse(page.socket.sent.at(-1)).expectedVersion, 2);
  assert.equal(visible(page.invite()), false);
});

test("server paid reset notice persists without repeating its live announcement", async () => {
  const page = await billPage({ paid: { guest: 1 } });
  const notice = page.element("paidResetNotice");
  assert.equal(visible(notice), false);
  page.update((bill) => { bill.paid = {}; bill.paidResetAt = 1234; bill.items[1].priceCents += 100; });
  assert.equal(visible(notice), true);
  assert.match(notice.textContent, /check any payments already sent before paying again/);
  assert.equal(notice.getAttribute("role"), "status");
  const announcementNode = notice.childNodes[0];
  page.update((bill) => { bill.people[1].name = "Renamed guest"; });
  assert.equal(visible(notice), true);
  assert.equal(notice.childNodes[0], announcementNode, "unrelated renders do not announce the same reset again");
  assert.equal(visible(page.invite()), false);
});

for (const [name, options] of [
  ["another guest has paid", { paid: { other: 1 } }],
  ["creator with a guest identity", { creator: true, paid: { guest: 1, other: 1 } }],
  ["payee without a creator token", { identity: "host", paid: { host: 1, guest: 1, other: 1 } }],
  ["unjoined visitor after everyone paid", { identity: null, paid: { guest: 1, other: 1 } }],
  ["unknown or removed participant", { identity: "removed", paid: { removed: 1, guest: 1, other: 1 } }],
  ["paid participant has no claims", { paid: { guest: 1 }, mutate: (bill) => { bill.claims.guestItem = { other: 1 }; } }],
  ["paid participant only owes zero", { paid: { guest: 1 }, mutate: (bill) => { bill.items[1].priceCents = 0; } }],
  ["priced items remain unclaimed", { paid: { guest: 1, other: 1 }, mutate: (bill) => { delete bill.claims.otherItem; } }],
]) test("guest invitation stays hidden when " + name, async () => {
  const page = await billPage(options);
  assert.equal(visible(page.invite()), false);
  assert.equal(page.invite().classList.contains("hidden"), true, "predicate itself must hide the invite, not only its parent view");
});

test("watching is not a conversion trigger; joining restores the genuine guest path", async () => {
  const page = await billPage({ identity: null, paid: { guest: 1, other: 1 } });
  page.element("watchBtn").click();
  page.update();
  assert.equal(visible(page.invite()), false);
  page.socket.receive({ type: "joined", personId: "guest", token: "new-private-token" });
  page.update();
  assert.equal(visible(page.invite()), true, "joining must clear prior spectator state");
});

test("repeated updates, reopened claims and removal keep the guest invitation accurate", async () => {
  const page = await billPage({ paid: { guest: 1 } });
  assert.equal(visible(page.invite()), true, "another participant does not need to be paid");
  page.update(); page.update();
  assert.equal(page.document.querySelectorAll("#nextBillInvite").length, 1);
  page.update((bill) => { delete bill.claims.otherItem; });
  assert.equal(visible(page.invite()), false);
  page.update((bill) => { bill.claims.otherItem = { other: 1 }; });
  assert.equal(visible(page.invite()), true);
  page.update((bill) => { bill.people = bill.people.filter((person) => person.id !== "guest"); bill.claims.guestItem = { other: 1 }; });
  assert.equal(visible(page.invite()), false);
  assert.equal(page.storage["splitty-me-" + billId], undefined, "removed identity is cleared");
});

test("unclaimed zero-price items do not block a paid guest's invitation", async () => {
  const page = await billPage({ paid: { guest: 1 }, mutate: (bill) => { bill.items.push({ id: "water", name: "Water", priceCents: 0 }); } });
  assert.equal(visible(page.invite()), true);
});

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name, error); }
}
console.log(`${tests.length - failed}/${tests.length} onboarding tests passed`);
process.exitCode = failed ? 1 : 0;
