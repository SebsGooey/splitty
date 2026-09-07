// Splitty — settle-up helpers shared by the create page and the bill page.
// The Worker (src/worker.js cleanPay) is the authority; this mirrors its rules
// so a typo is caught before it's sent, and builds the deep links.
"use strict";

const PAY_NETWORKS = [
  {
    key: "venmo", label: "Venmo", field: "Venmo username", placeholder: "@username",
    re: /^[A-Za-z0-9_-]{5,30}$/, rule: "5–30 letters, numbers, - or _",
    handle: (u) => "@" + u,
    href: (u, amt, note) => `https://venmo.com/${encodeURIComponent(u)}?txn=pay&amount=${amt}&note=${encodeURIComponent(note)}`,
  },
  {
    key: "cashapp", label: "Cash App", field: "$Cashtag", placeholder: "$cashtag",
    re: /^[A-Za-z][A-Za-z0-9_]{0,19}$/, rule: "starts with a letter, up to 20 letters or numbers",
    handle: (u) => "$" + u,
    href: (u, amt) => `https://cash.app/$${encodeURIComponent(u)}/${amt}`,
  },
  {
    key: "paypal", label: "PayPal", field: "PayPal.Me name", placeholder: "paypal.me/name",
    re: /^[A-Za-z0-9]{1,20}$/, rule: "up to 20 letters or numbers",
    handle: (u) => "paypal.me/" + u,
    href: (u, amt) => `https://paypal.me/${encodeURIComponent(u)}/${amt}USD`,
  },
];

// Normalise one typed handle the way the server does: strip a pasted profile
// URL, a leading @ or $, and surrounding whitespace.
function normalizePayHandle(raw) {
  let v = String(raw ?? "").trim().slice(0, 120);
  v = v.replace(/^(https?:\/\/)?(www\.)?(account\.)?(venmo\.com\/(u\/)?|cash\.app\/|paypal\.me\/|paypal\.com\/paypalme\/)/i, "");
  return v.replace(/[/?#].*$/, "").replace(/^[@$]+/, "").trim();
}

// -> { value: { venmo?, cashapp?, paypal? } } or { error: "…" } for the first
// non-empty handle that breaks its network's rules.
function cleanPayClient(pay) {
  const value = {};
  for (const n of PAY_NETWORKS) {
    const v = normalizePayHandle(pay[n.key]);
    if (!v) continue;
    if (!n.re.test(v)) return { error: `That ${n.field} doesn't look right — ${n.rule}.` };
    value[n.key] = v;
  }
  return { value };
}

const payDollars = (cents) => (cents / 100).toFixed(2);

function payLinks(pay, cents, note) {
  return PAY_NETWORKS.filter((n) => pay[n.key]).map((n) => ({ ...n, user: pay[n.key], url: n.href(pay[n.key], payDollars(cents), note) }));
}

function payHandlesText(pay) {
  return PAY_NETWORKS.filter((n) => pay[n.key]).map((n) => `${n.label} ${n.handle(pay[n.key])}`).join(" · ");
}

// Display form for a stored bare handle (what goes back into the input).
function payHandleDisplay(key, u) {
  const n = PAY_NETWORKS.find((x) => x.key === key);
  return u && n ? n.handle(u) : "";
}
