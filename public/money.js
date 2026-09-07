// Splitty — money math shared by the bill page and the tests.
// Plain script (no module) so bill.html can load it with a <script> tag; the
// test suite evaluates it in a vm context. Everything here is pure.
"use strict";

// ---------- money math: exact allocation with largest remainder ----------
function allocate(totalCents, weights) {
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0 || totalCents <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (totalCents * w) / sumW);
  const base = exact.map(Math.floor);
  let leftover = totalCents - base.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < leftover; k++) base[order[k % order.length].i]++;
  return base;
}

// claims[itemId] = { personId: units }. Each person pays in proportion to the
// units they had; if fewer units are claimed than the line's qty, the rest of
// the line stays unclaimed. (Older bills arrive as arrays = 1 unit each.)
function claimEntries(b, itemId) {
  const raw = b.claims[itemId];
  if (Array.isArray(raw)) return raw.map((pid) => [pid, 1]);
  return Object.entries(raw || {});
}
function unitsOf(b, itemId, personId) {
  const raw = b.claims[itemId];
  if (Array.isArray(raw)) return raw.includes(personId) ? 1 : 0;
  return (raw && raw[personId]) || 0;
}

function computeTotals(b) {
  const subtotal = b.items.reduce((a, i) => a + i.priceCents, 0);
  const shares = Object.fromEntries(b.people.map((p) => [p.id, 0]));
  const perPersonItems = Object.fromEntries(b.people.map((p) => [p.id, []]));
  let claimed = 0;
  for (const item of b.items) {
    const owners = claimEntries(b, item.id).filter(([pid, u]) => pid in shares && u > 0);
    if (!owners.length) continue;
    const qty = item.qty || 1;
    const total = owners.reduce((a, [, u]) => a + u, 0);
    // Weights are units; a trailing weight holds the unclaimed units, if any.
    const weights = owners.map(([, u]) => u);
    if (total < qty) weights.push(qty - total);
    const parts = allocate(item.priceCents, weights);
    owners.forEach(([pid, u], idx) => {
      shares[pid] += parts[idx];
      claimed += parts[idx];
      perPersonItems[pid].push({ item, part: parts[idx], units: u, of: Math.max(total, qty), sharers: owners.length });
    });
  }
  const unclaimed = subtotal - claimed;
  const tipTotal = b.tip.mode === "percent" ? Math.round((subtotal * b.tip.value) / 100) : b.tip.value;
  // Weights drive tax/tip allocation. If every item is $0 (all-zero-price bill)
  // the proportional weights vanish — fall back to an equal split so tax/tip
  // still land on people instead of nobody.
  const weights = subtotal === 0 && b.people.length
    ? [...b.people.map(() => 1), 0]
    : [...b.people.map((p) => shares[p.id]), unclaimed];
  const taxAlloc = allocate(b.taxCents, weights);
  const tipAlloc = allocate(tipTotal, weights);
  const perPerson = b.people.map((p, idx) => ({
    person: p,
    items: perPersonItems[p.id],
    shareCents: shares[p.id],
    taxCents: taxAlloc[idx],
    tipCents: tipAlloc[idx],
    totalCents: shares[p.id] + taxAlloc[idx] + tipAlloc[idx],
  }));
  return { subtotal, tipTotal, unclaimed, perPerson,
    unclaimedTax: taxAlloc[b.people.length] || 0, unclaimedTip: tipAlloc[b.people.length] || 0 };
}

