// Splitty — Cloudflare Worker + Durable Objects
// One BillRoom DO per bill = database + write serializer + WebSocket broadcast hub.
// One singleton Meter DO = per-IP/global daily rate caps for the money-spending endpoints.

const COLORS = ["#e0523a", "#2563eb", "#059669", "#9333ea", "#d97706", "#0891b2", "#db2777", "#65a30d", "#7c3aed", "#b91c1c", "#0d9488"];
const MAX_ITEMS = 100;
const MAX_PEOPLE = 30;
const MAX_CENTS = 10_000_000; // $100,000 per line — beyond any dinner
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_MS = 90 * DAY_MS;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const b = new Uint8Array(16); // 128 bits
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// ---------- input validation ----------

function cleanItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) return null;
  const out = [];
  for (const it of items) {
    const name = String(it?.name ?? "").trim().slice(0, 80);
    const qty = Number.isInteger(it?.qty) && it.qty >= 1 && it.qty <= 99 ? it.qty : 1;
    const priceCents = it?.priceCents;
    if (!name || !Number.isInteger(priceCents) || priceCents < 0 || priceCents > MAX_CENTS) return null;
    out.push({ id: typeof it.id === "string" && /^i[A-Za-z0-9_-]{1,12}$/.test(it.id) ? it.id : "i" + randomToken().slice(0, 8), name, qty, priceCents });
  }
  // ids must be unique
  if (new Set(out.map((i) => i.id)).size !== out.length) return null;
  return out;
}

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

function cleanBillFields(body) {
  const items = cleanItems(body.items);
  if (!items) return { error: "Items are missing or invalid." };
  const restaurant = String(body.restaurant ?? "").trim().slice(0, 80) || "Untitled bill";
  const rawTax = Number(body.taxCents);
  const taxCents = Number.isFinite(rawTax) ? clamp(Math.round(rawTax), 0, MAX_CENTS) : 0;
  // Clamp (not zero) out-of-range tips so the stored bill matches what the
  // client previews; clients apply the identical clamp before showing totals.
  let tip = { mode: "percent", value: 0 };
  if (body.tip && body.tip.mode === "amount") {
    const v = Number(body.tip.value);
    tip = { mode: "amount", value: Number.isFinite(v) ? clamp(Math.round(v), 0, MAX_CENTS) : 0 };
  } else if (body.tip && body.tip.mode === "percent") {
    const v = Number(body.tip.value);
    tip = { mode: "percent", value: Number.isFinite(v) ? Math.round(clamp(v, 0, 100) * 10) / 10 : 0 };
  }
  return { restaurant, items, taxCents, tip };
}

// ---------- settle up: payment handles ----------
// The creator shares where friends can pay them back. Stored as bare usernames
// (no @ / $ / URL), validated per network, and turned into deep links with the
// amount filled in on the bill page. An absent key means "not offered".
const PAY_RULES = {
  venmo: { re: /^[A-Za-z0-9_-]{5,30}$/, label: "Venmo username", rule: "5–30 letters, numbers, - or _" },
  cashapp: { re: /^[A-Za-z][A-Za-z0-9_]{0,19}$/, label: "$Cashtag", rule: "starts with a letter, up to 20 letters or numbers" },
  paypal: { re: /^[A-Za-z0-9]{1,20}$/, label: "PayPal.Me name", rule: "up to 20 letters or numbers" },
};

// Returns { value } with only the valid, non-empty handles, or { error } naming
// the first field that doesn't look right (so the creator can fix it rather
// than have it silently vanish). Pasted profile URLs and @/$ prefixes are OK.
function cleanPay(pay) {
  const value = {};
  if (pay == null) return { value };
  if (typeof pay !== "object") return { error: "Payment details are invalid." };
  for (const [k, spec] of Object.entries(PAY_RULES)) {
    let v = String(pay[k] ?? "").trim().slice(0, 120);
    v = v.replace(/^(https?:\/\/)?(www\.)?(account\.)?(venmo\.com\/(u\/)?|cash\.app\/|paypal\.me\/|paypal\.com\/paypalme\/)/i, "");
    v = v.replace(/[/?#].*$/, "").replace(/^[@$]+/, "").trim();
    if (!v) continue;
    if (!spec.re.test(v)) return { error: `That ${spec.label} doesn't look right — ${spec.rule}.` };
    value[k] = v;
  }
  return { value };
}

// ---------- claims: who had how many of each item ----------
// claims[itemId] is { personId: units }. Units are whole items (a person who
// had 2 of the 3 beers claims 2). Cost splits in proportion to units; if fewer
// units are claimed than the line's qty, the rest stays unclaimed. Bills from
// before this model stored claims as arrays of personIds — read as 1 unit each
// and rewritten on the next save.
const MAX_UNITS = 99;

function normalizeClaims(bill) {
  let changed = false;
  const out = {};
  for (const [itemId, v] of Object.entries(bill.claims || {})) {
    let entry;
    if (Array.isArray(v)) {
      entry = Object.fromEntries(v.filter((pid) => typeof pid === "string").map((pid) => [pid, 1]));
      changed = true;
    } else if (v && typeof v === "object") {
      entry = {};
      for (const [pid, units] of Object.entries(v)) {
        if (Number.isInteger(units) && units >= 1 && units <= MAX_UNITS) entry[pid] = units;
        else changed = true;
      }
    } else {
      changed = true;
      continue;
    }
    if (Object.keys(entry).length) out[itemId] = entry;
    else changed = true;
  }
  bill.claims = out;
  return changed;
}

// Drop one person from every claim; delete claims left empty.
function dropPersonClaims(bill, personId) {
  for (const [itemId, entry] of Object.entries(bill.claims)) {
    if (personId in entry) {
      delete entry[personId];
      if (!Object.keys(entry).length) delete bill.claims[itemId];
    }
  }
}

// Take a person off a bill entirely: their entry, claims, paid mark, and the
// "this is the creator" tag if it was them.
function removePersonFromBill(bill, personId) {
  bill.people = bill.people.filter((x) => x.id !== personId);
  dropPersonClaims(bill, personId);
  if (bill.paid) delete bill.paid[personId];
  if (bill.creatorPersonId === personId) delete bill.creatorPersonId;
}

// Accepts a bare bill id or a bill link (…/b/<id>, with or without #edit=…).
function billIdFrom(s) {
  const m = String(s || "").trim().match(/(?:^|\/b\/)([A-Za-z0-9_-]{16,64})(?:[#?].*)?$/);
  return m ? m[1] : null;
}

// ---------- link previews ----------
// Messaging apps fetch a bill link to build a preview card. Say what the bill
// is (its name, item and people counts) but never amounts or people's names:
// whoever fetches the preview already holds the link, and the card should
// help the table recognise the bill, not leak it.
const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function billPreview(env, billId, url) {
  const origin = "https://" + (env.CANONICAL_HOST || url.host);
  const preview = {
    title: "Splitty · split the bill",
    description: "Tap what you had — totals update live on every phone with this link.",
    url: origin + url.pathname,
    image: origin + "/icons/og-card.png",
  };
  try {
    // Bounded: a slow Durable Object must not hold up the page; the generic
    // card is fine in that case.
    const stub = env.BILL_ROOM.get(env.BILL_ROOM.idFromName(billId));
    const res = await Promise.race([stub.fetch("https://do/state"), new Promise((r) => setTimeout(() => r(null), 1000))]);
    if (res && res.ok) {
      const { bill } = await res.json();
      const items = bill.items.length, people = bill.people.length;
      preview.title = bill.restaurant + " · Splitty";
      preview.description = `${items} item${items === 1 ? "" : "s"} · ${people} ${people === 1 ? "person" : "people"} so far. Tap what you had — totals update live.`;
    }
  } catch {}
  return preview;
}

function previewTags(p) {
  return [
    ["property", "og:type", "website"], ["property", "og:site_name", "Splitty"],
    ["property", "og:title", p.title], ["property", "og:description", p.description], ["property", "og:url", p.url],
    ["property", "og:image", p.image], ["property", "og:image:width", "1200"], ["property", "og:image:height", "630"],
    ["property", "og:image:type", "image/png"], ["property", "og:image:alt", "Splitty"],
    ["name", "twitter:card", "summary"],
  ].map(([attr, k, v]) => `<meta ${attr}="${k}" content="${escAttr(v)}">`).join("");
}

function publicBill(bill) {
  return {
    ...bill,
    creatorTokenHash: undefined,
    pay: bill.pay || {},
    paid: bill.paid || {},
    people: bill.people.map(({ tokenHash, ...p }) => p),
  };
}

// ---------- Google sign-in + sessions ----------
// Gate is dormant until GOOGLE_CLIENT_ID (var) + SESSION_SECRET (secret) exist,
// same activation pattern as receipt scanning. It protects the money side
// (create/scan); joining a bill via share link never requires an account.

const SESSION_COOKIE = "splitty_session";
const SESSION_TTL_MS = 30 * DAY_MS;

// "on" needs both halves; exactly one configured is an operator mistake and
// must fail CLOSED on the money endpoints, not silently run ungated.
function authState(env) {
  const hasId = Boolean(env.GOOGLE_CLIENT_ID);
  const hasSecret = Boolean(env.SESSION_SECRET);
  if (hasId && hasSecret) return "on";
  if (hasId || hasSecret) return "misconfigured";
  return "off";
}
const authRequired = (env) => authState(env) === "on";

const b64urlEncode = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

function b64urlDecode(s) {
  s = s.replaceAll("-", "+").replaceAll("_", "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret, usages) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

async function signSession(payload, secret) {
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return body + "." + b64urlEncode(sig);
}

async function verifySessionToken(token, secret) {
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  try {
    const key = await hmacKey(secret, ["verify"]);
    const ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(token.slice(dot + 1)), new TextEncoder().encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!payload || typeof payload.sub !== "string" || typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

async function getSession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)splitty_session=([A-Za-z0-9_.-]+)/);
  if (!m) return null;
  return verifySessionToken(m[1], env.SESSION_SECRET);
}

// Google's JWKS, cached per isolate. Keys rotate on the order of days; a short
// TTL keeps rotation safe without a fetch per sign-in. Forced refetches (on an
// unknown kid) are rate-limited so bogus tokens can't turn us into a JWKS
// fetch loop.
let jwksCache = { keys: null, fetchedAt: 0 };
let jwksLastForced = 0;

async function getGoogleJwks() {
  if (jwksCache.keys && Date.now() - jwksCache.fetchedAt < 3 * 60 * 60 * 1000) return jwksCache.keys;
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!res.ok) throw new Error("jwks fetch failed");
  const { keys } = await res.json();
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

async function verifyGoogleIdToken(idToken, clientId) {
  if (typeof idToken !== "string" || idToken.length > 4096) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  let jwk = (await getGoogleJwks()).find((k) => k.kid === header.kid);
  if (!jwk) {
    // Key rotation between cache refreshes — refetch, at most once a minute.
    if (Date.now() - jwksLastForced < 60_000) return null;
    jwksLastForced = Date.now();
    jwksCache = { keys: null, fetchedAt: 0 };
    jwk = (await getGoogleJwks()).find((k) => k.kid === header.kid);
    if (!jwk) return null;
  }
  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlDecode(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1]),
    );
  } catch {
    return null; // malformed signature/key material is a bad token, not a server error
  }
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") return null;
  if (payload.aud !== clientId) return null;
  if (typeof payload.exp !== "number" || payload.exp < now - 60) return null;
  if (typeof payload.sub !== "string" || !payload.sub) return null;
  return payload;
}

function sessionCookie(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

async function handleGoogleAuth(request, env) {
  if (!authRequired(env)) return json({ error: "Sign-in isn't configured." }, 501);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }
  let payload;
  try {
    payload = await verifyGoogleIdToken(body.credential, env.GOOGLE_CLIENT_ID);
  } catch {
    // JWKS unreachable — a server-side hiccup, not a bad credential.
    return json({ error: "Sign-in is temporarily unavailable — try again in a minute." }, 503);
  }
  if (!payload) return json({ error: "Sign-in failed — try again." }, 401);
  const session = {
    sub: payload.sub,
    // Only trust the email claim when Google says it's verified.
    email: payload.email_verified === true && typeof payload.email === "string" ? payload.email.slice(0, 120) : "",
    name: typeof payload.name === "string" ? payload.name.slice(0, 80) : "",
    exp: Date.now() + SESSION_TTL_MS,
  };
  const token = await signSession(session, env.SESSION_SECRET);
  return json(
    { user: { email: session.email, name: session.name } },
    200,
    { "set-cookie": sessionCookie(token, SESSION_TTL_MS / 1000) },
  );
}

// ---------- accounts, tiers, admin ----------
// Joining a bill via its link never needs an account. Creating bills and
// scanning receipts do (Google sign-in), and those sit behind tiers:
//   free  — FREE_BILLS_PER_MONTH manual bills a month, no receipt scanning
//   pro   — unlimited bills (still under the abuse caps) + scanning
// Pro comes from a Stripe subscription, an admin grant, or being listed in
// ADMIN_EMAILS. Everything lives in the singleton Accounts Durable Object.
const FREE_BILLS_PER_MONTH = 3;
const FOREVER = 32503680000000; // 2999-12-31 — "no end date" for admin grants
const PRO_GRACE_MS = 3 * DAY_MS; // slack past a period end while Stripe retries a card

function adminEmails(env) {
  return new Set(String(env.ADMIN_EMAILS || "").toLowerCase().split(/[,\s]+/).filter(Boolean));
}
const isAdminSession = (session, env) => Boolean(session?.email) && adminEmails(env).has(session.email.toLowerCase());

const accountsStub = (env) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName("global"));

async function accountsCall(env, path, body) {
  const res = await accountsStub(env).fetch("https://do" + path, { method: "POST", body: JSON.stringify(body || {}) });
  if (!res.ok) throw new Error("accounts " + path + " " + res.status);
  return res.json();
}

// What a signed-in person may do right now. If the Accounts DO is unreachable
// we degrade to "free, or pro if admin" and say so, rather than failing.
async function entitlementFor(session, env) {
  const isAdmin = isAdminSession(session, env);
  try {
    return await accountsCall(env, "/touch", { sub: session.sub, email: session.email, name: session.name, isAdmin });
  } catch {
    return {
      tier: isAdmin ? "pro" : "free", isPro: isAdmin, proUntil: null, proSource: isAdmin ? "admin-email" : null,
      billsUsed: 0, billsLimit: isAdmin ? null : FREE_BILLS_PER_MONTH, billsLeft: isAdmin ? null : FREE_BILLS_PER_MONTH,
      canScan: isAdmin, hasStripeCustomer: false, isAdmin, degraded: true,
    };
  }
}

function stripeEnabled(env) {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID && env.STRIPE_WEBHOOK_SECRET);
}
function billingInfo(env) {
  return { enabled: stripeEnabled(env), priceLabel: env.PRO_PRICE_LABEL || "$2.99 / month", freeBillsPerMonth: FREE_BILLS_PER_MONTH };
}
// The Stripe customer id stays server-side; everything else is the person's own.
function publicAccount(account) {
  if (!account) return null;
  const { stripeCustomer, ...rest } = account;
  return rest;
}

// ---------- Worker (router) ----------

// Browsers always send Origin on cross-site POSTs; a mismatched Origin means a
// drive-by page is spending our Anthropic budget or creating bills via a
// visitor's browser. Non-browser clients (no Origin header) are not CSRF.
// (The session cookie is additionally SameSite=Lax.)
function crossOrigin(request, url) {
  const origin = request.headers.get("Origin");
  return Boolean(origin && origin !== url.origin);
}

// One canonical host. Page loads on the workers.dev URL or www. redirect to
// CANONICAL_HOST; API and WebSocket calls are left alone so a tab that was
// opened on the old host keeps working until it reloads.
function canonicalRedirect(request, env, url) {
  const host = env.CANONICAL_HOST;
  if (!host || request.method !== "GET" || url.pathname.startsWith("/api/")) return null;
  if (url.hostname !== host && (url.hostname.endsWith(".workers.dev") || url.hostname === "www." + host)) {
    return Response.redirect(`https://${host}${url.pathname}${url.search}`, 301);
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      const moved = canonicalRedirect(request, env, url);
      if (moved) return moved;
      if (request.method === "POST" && path.startsWith("/api/") && crossOrigin(request, url)) {
        return json({ error: "Cross-origin requests are not allowed." }, 403);
      }
      if (path === "/api/config") {
        return json({
          parseEnabled: Boolean(env.ANTHROPIC_API_KEY),
          turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
          authRequired: authRequired(env),
          authMisconfigured: authState(env) === "misconfigured",
          googleClientId: env.GOOGLE_CLIENT_ID || null,
          billing: billingInfo(env),
        });
      }

      if (path === "/api/auth/google" && request.method === "POST") return handleGoogleAuth(request, env);
      if (path === "/api/auth/logout" && request.method === "POST") {
        return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
      }
      if (path === "/api/me" && request.method === "GET") {
        const s = await getSession(request, env);
        const account = s && authRequired(env) ? await entitlementFor(s, env) : null;
        return json({ user: s ? { email: s.email, name: s.name } : null, authRequired: authRequired(env), account: publicAccount(account), billing: billingInfo(env) });
      }

      if (path === "/api/billing/checkout" && request.method === "POST") return billingCheckout(request, env, url);
      if (path === "/api/billing/portal" && request.method === "POST") return billingPortal(request, env, url);
      if (path === "/api/stripe/webhook" && request.method === "POST") return stripeWebhook(request, env);

      if (path.startsWith("/api/admin/")) return adminApi(request, env, path);

      if (path === "/api/bills" && request.method === "POST") return createBill(request, env);

      const billMatch = path.match(/^\/api\/bills\/([A-Za-z0-9_-]{16,64})(\/ws)?$/);
      if (billMatch) {
        const stub = env.BILL_ROOM.get(env.BILL_ROOM.idFromName(billMatch[1]));
        if (billMatch[2]) return stub.fetch(new Request("https://do/ws", request));
        if (request.method === "GET") return stub.fetch("https://do/state");
        return json({ error: "Method not allowed" }, 405);
      }

      if (path === "/api/parse" && request.method === "POST") return parseReceipt(request, env);

      if (/^\/b\/[A-Za-z0-9_-]{16,64}$/.test(path)) {
        const [res, preview] = await Promise.all([
          env.ASSETS.fetch(new Request(new URL("/bill.html", url.origin))),
          billPreview(env, path.slice(3), url),
        ]);
        const headers = new Headers(res.headers);
        headers.set("referrer-policy", "no-referrer");
        headers.set("x-robots-tag", "noindex");
        return new HTMLRewriter()
          .on("title", { element(el) { el.setInnerContent(preview.title); } })
          .on("head", { element(el) { el.append(previewTags(preview), { html: true }); } })
          .transform(new Response(res.body, { status: res.status, headers }));
      }

      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: "Server error" }, 500);
    }
  },
};

async function meterCheck(env, request, kind, session) {
  try {
    // Meter BOTH the IP and (when signed in) the Google account: an abuser
    // then needs to rotate IPs *and* verified Google accounts to scale.
    const keys = [(await sha256("ip:" + (request.headers.get("CF-Connecting-IP") || "local"))).slice(0, 16)];
    if (session?.sub) keys.push((await sha256("u:" + session.sub)).slice(0, 16));
    const stub = env.METER.get(env.METER.idFromName("global"));
    const res = await stub.fetch("https://do/check", {
      method: "POST",
      body: JSON.stringify({ kind, keys }),
    });
    return await res.json();
  } catch {
    // If the meter itself breaks, fail open for creates but closed for paid parses.
    return { ok: kind !== "parse", message: "Rate limiter unavailable — try again shortly." };
  }
}

async function createBill(request, env) {
  if (authState(env) === "misconfigured") {
    return json({ error: "Sign-in is half-configured on the server — set both GOOGLE_CLIENT_ID and SESSION_SECRET." }, 503);
  }
  const session = await getSession(request, env);
  if (authRequired(env) && !session) {
    return json({ error: "Sign in with Google to create bills." }, 401);
  }

  // Validate before metering so malformed requests can't burn the daily budget.
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }
  const fields = cleanBillFields(body);
  if (fields.error) return json({ error: fields.error }, 400);
  const pay = cleanPay(body.pay);
  if (pay.error) return json({ error: pay.error }, 400);

  const meter = await meterCheck(env, request, "create", session);
  if (!meter.ok) return json({ error: meter.message }, 429);

  // Tiers: free accounts get FREE_BILLS_PER_MONTH; Pro/admin are unlimited.
  // Counted after the abuse meter so junk can't burn someone's monthly quota.
  if (session && authRequired(env)) {
    let quota;
    try {
      quota = await accountsCall(env, "/consume", { sub: session.sub, email: session.email, name: session.name, kind: "bill", isAdmin: isAdminSession(session, env) });
    } catch {
      quota = { ok: true }; // accounts store unreachable — a free bill is cheap, don't block the table
    }
    if (!quota.ok) return json({ error: quota.message, upgrade: true, account: publicAccount(quota.entitlement) }, 402);
  }

  const billId = randomToken();
  const creatorToken = randomToken();
  const now = Date.now();
  const bill = {
    v: 1,
    billId,
    version: 1,
    createdAt: now,
    lastActivity: now,
    currency: "USD",
    ...fields,
    people: [],
    claims: {},
    pay: pay.value, // where to pay the creator back: { venmo?, cashapp?, paypal? }
    paid: {}, // personId -> ms timestamp when marked as settled
    creatorTokenHash: await sha256(creatorToken),
    locked: false,
  };

  const stub = env.BILL_ROOM.get(env.BILL_ROOM.idFromName(billId));
  const res = await stub.fetch("https://do/init", { method: "POST", body: JSON.stringify(bill) });
  if (!res.ok) return json({ error: "Could not create the bill. Try again." }, 500);
  return json({ billId, creatorToken });
}

// ---------- receipt parsing (Claude vision) ----------

const PARSE_PROMPT = `Transcribe this restaurant receipt into the JSON schema.

Rules:
- Prices are integer cents (e.g. $34.50 -> 3450).
- Receipt photos often have the price column vertically misaligned from item names. Align each price with its correct item; verify by checking that item prices sum to the printed subtotal.
- Merge modifier/add-on lines (e.g. "ADD MANGO PUREE 1.00", "sub truffle fries 3.50") into their parent item as one combined item with the combined price.
- A line with quantity N priced as one amount stays ONE item with qty N only if it is truly one shared line; identical items rung up separately stay separate items (one entry per physical item).
- tipOrServiceCents: any printed service charge, auto-gratuity, or tip. 0 if absent.
- Do NOT include street addresses, phone numbers, card digits, or server names anywhere in the output.
- If something is unreadable or the math does not reconcile, still return your best transcription and explain in warnings.`;

const PARSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["restaurant", "items", "subtotalCents", "taxCents", "tipOrServiceCents", "totalCents", "warnings"],
  properties: {
    restaurant: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "qty", "priceCents"],
        properties: {
          name: { type: "string" },
          qty: { type: "integer" },
          priceCents: { type: "integer" },
        },
      },
    },
    subtotalCents: { type: "integer" },
    taxCents: { type: "integer" },
    tipOrServiceCents: { type: "integer" },
    totalCents: { type: "integer" },
    warnings: { type: "array", items: { type: "string" } },
  },
};

async function parseReceipt(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "Receipt scanning isn't set up yet — enter the items manually." }, 501);
  }
  if (authState(env) === "misconfigured") {
    return json({ error: "Sign-in is half-configured on the server — set both GOOGLE_CLIENT_ID and SESSION_SECRET." }, 503);
  }
  const session = await getSession(request, env);
  if (authRequired(env) && !session) {
    return json({ error: "Sign in with Google to scan receipts." }, 401);
  }
  // Scanning spends real money, so it is Pro-only (fail closed if the accounts
  // store is unreachable — the manual path still works).
  let account = null;
  if (session && authRequired(env)) {
    account = await entitlementFor(session, env);
    if (!account.canScan) {
      return json({ error: "Receipt scanning is a Pro feature — upgrade, or type the items in (it's quick).", upgrade: true, account: publicAccount(account) }, 402);
    }
  }
  // Require a sane, explicit Content-Length: absent (chunked) or non-numeric
  // values must not slip past the size guard as 0/NaN.
  const contentLength = Number(request.headers.get("content-length"));
  if (!Number.isFinite(contentLength) || contentLength <= 0) return json({ error: "Bad request" }, 411);
  if (contentLength > 8_000_000) return json({ error: "That photo is too large — try again (it should auto-shrink)." }, 413);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }
  const { media_type, data, turnstileToken } = body;
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(media_type) ||
    typeof data !== "string" ||
    data.length < 100 ||
    data.length > 8_000_000
  ) {
    return json({ error: "That doesn't look like a photo we can read." }, 400);
  }

  if (env.TURNSTILE_SECRET) {
    const ok = await verifyTurnstile(env, turnstileToken, request);
    if (!ok) return json({ error: "Bot check failed — reload the page and try again." }, 403);
  }

  // Meter AFTER validation + bot check (junk must not drain the daily budget),
  // but BEFORE the actual spend below.
  const meter = await meterCheck(env, request, "parse", session);
  if (!meter.ok) return json({ error: meter.message }, 429);

  // effort is an Opus-5-tier request feature; sending it to e.g.
  // claude-haiku-4-5 is an upstream 400. (No fallbacks param: a refusal on a
  // receipt photo is vanishingly rare and manual entry is the real fallback.)
  const model = env.PARSE_MODEL || "claude-opus-5";
  const isOpus5Tier = /^claude-(opus-5|fable-5|mythos-5)/.test(model);
  // Real keys are printable ASCII; pasted secrets sometimes smuggle in
  // zero-width/BOM characters that make the header invalid HTTP and get the
  // request rejected upstream with a bare 400. Strip anything else.
  const apiKey = env.ANTHROPIC_API_KEY.replace(/[^\x21-\x7e]/g, "");
  const headers = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
  const req = {
    model,
    max_tokens: 16000,
    output_config: { format: { type: "json_schema", schema: PARSE_SCHEMA } },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type, data } },
          { type: "text", text: PARSE_PROMPT },
        ],
      },
    ],
  };
  if (isOpus5Tier) {
    req.output_config.effort = "medium";
  }

  const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(req),
  });

  if (!apiRes.ok) {
    let detail = "";
    try {
      detail = JSON.parse(await apiRes.text())?.error?.message?.slice(0, 200) || "";
    } catch {}
    console.error("anthropic error", apiRes.status, detail);
    return json({ error: `Receipt scanning failed (upstream ${apiRes.status}${detail ? ": " + detail : ""}). Try again or enter items manually.` }, 502);
  }
  const msg = await apiRes.json();
  if (msg.stop_reason === "refusal") {
    return json({ error: "That image couldn't be processed — enter the items manually." }, 422);
  }
  if (msg.stop_reason === "max_tokens") {
    return json({ error: "That receipt is too long to scan in one go — enter the items manually." }, 422);
  }
  const text = (msg.content || []).find((b) => b.type === "text")?.text;
  let draft;
  try {
    draft = JSON.parse(text);
  } catch {
    return json({ error: "Couldn't read that receipt — try a clearer photo, or enter items manually." }, 422);
  }

  // Server-side sanity: clamp and flag mismatched sums so the review UI can warn.
  const itemSum = (draft.items || []).reduce((a, i) => a + (Number.isInteger(i.priceCents) ? i.priceCents : 0), 0);
  if (Number.isInteger(draft.subtotalCents) && Math.abs(itemSum - draft.subtotalCents) > 1) {
    draft.warnings = [...(draft.warnings || []), `Item prices sum to ${(itemSum / 100).toFixed(2)} but the printed subtotal reads ${(draft.subtotalCents / 100).toFixed(2)} — double-check the items.`];
  }
  if (session && authRequired(env)) {
    // Usage bookkeeping only (Pro scans are unlimited); never fail the scan over it.
    try { await accountsCall(env, "/consume", { sub: session.sub, email: session.email, name: session.name, kind: "scan", isAdmin: isAdminSession(session, env) }); } catch {}
  }
  return json({ draft });
}

// ---------- Stripe billing ----------
// Checkout → webhook → Accounts DO. All three secrets must be present for the
// upgrade button to do anything; until then it says "coming soon".

async function stripeApi(env, path, form) {
  const res = await fetch("https://api.stripe.com" + path, {
    method: "POST",
    headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("stripe error", res.status, data?.error?.message);
    throw new Error(data?.error?.message || "stripe " + res.status);
  }
  return data;
}

async function billingCheckout(request, env, url) {
  if (!stripeEnabled(env)) return json({ error: "Upgrades aren't switched on yet." }, 501);
  const session = await getSession(request, env);
  if (!session) return json({ error: "Sign in first." }, 401);
  const account = await entitlementFor(session, env);
  if (account.isPro && account.proSource !== "stripe") {
    return json({ error: "You already have Pro." }, 409);
  }
  const form = {
    mode: "subscription",
    "line_items[0][price]": env.STRIPE_PRICE_ID,
    "line_items[0][quantity]": "1",
    success_url: url.origin + "/?upgraded=1",
    cancel_url: url.origin + "/?upgrade=cancelled",
    client_reference_id: session.sub,
    "metadata[sub]": session.sub,
    "subscription_data[metadata][sub]": session.sub,
    allow_promotion_codes: "true",
  };
  if (account.stripeCustomer) form.customer = account.stripeCustomer;
  else if (session.email) form.customer_email = session.email;
  try {
    const checkout = await stripeApi(env, "/v1/checkout/sessions", form);
    return json({ url: checkout.url });
  } catch {
    return json({ error: "Couldn't start checkout — try again in a minute." }, 502);
  }
}

async function billingPortal(request, env, url) {
  if (!stripeEnabled(env)) return json({ error: "Billing isn't switched on yet." }, 501);
  const session = await getSession(request, env);
  if (!session) return json({ error: "Sign in first." }, 401);
  const account = await entitlementFor(session, env);
  if (!account.stripeCustomer) return json({ error: "No subscription to manage on this account." }, 404);
  try {
    const portal = await stripeApi(env, "/v1/billing_portal/sessions", { customer: account.stripeCustomer, return_url: url.origin + "/" });
    return json({ url: portal.url });
  } catch {
    return json({ error: "Couldn't open the billing portal — try again in a minute." }, 502);
  }
}

// Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>]; signed payload is "<t>.<raw body>".
async function verifyStripeSignature(header, rawBody, secret, toleranceSec = 300) {
  if (!header) return false;
  const parts = Object.create(null);
  const sigs = [];
  for (const kv of header.split(",")) {
    const [k, v] = kv.split("=", 2).map((s) => s && s.trim());
    if (k === "t") parts.t = v;
    else if (k === "v1" && v) sigs.push(v.toLowerCase());
  }
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !sigs.length) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSec) return false;
  const key = await hmacKey(secret, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${parts.t}.${rawBody}`)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  // Constant-time compare against each provided v1.
  return sigs.some((s) => {
    if (s.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < s.length; i++) diff |= s.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

async function stripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "Webhooks aren't configured." }, 501);
  const raw = await request.text();
  if (raw.length > 1_000_000) return json({ error: "Payload too large" }, 413);
  if (!(await verifyStripeSignature(request.headers.get("stripe-signature"), raw, env.STRIPE_WEBHOOK_SECRET))) {
    return json({ error: "Bad signature" }, 400);
  }
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "Bad payload" }, 400);
  }
  if (!event || typeof event.id !== "string" || typeof event.type !== "string") return json({ error: "Bad event" }, 400);
  try {
    const result = await accountsCall(env, "/stripe", { event });
    return json({ received: true, ...result });
  } catch {
    // 5xx makes Stripe retry, which is what we want if the store hiccups.
    return json({ error: "Store unavailable" }, 503);
  }
}

// ---------- admin API ----------

async function adminApi(request, env, path) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Sign in first." }, 401);
  if (!isAdminSession(session, env)) return json({ error: "Admins only." }, 403);
  if (path === "/api/admin/users" && request.method === "GET") {
    try {
      const res = await accountsStub(env).fetch("https://do/users");
      return json(await res.json());
    } catch {
      return json({ error: "Accounts store unavailable." }, 503);
    }
  }
  if (path === "/api/admin/grant" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Bad request" }, 400);
    }
    const email = String(body.email || "").trim().toLowerCase().slice(0, 120);
    const sub = typeof body.sub === "string" ? body.sub.slice(0, 80) : "";
    if (!email && !sub) return json({ error: "Give an email or account id." }, 400);
    let until;
    if (body.revoke) until = 0;
    else if (body.forever) until = FOREVER;
    else {
      const months = Number.isInteger(body.months) ? Math.min(Math.max(body.months, 1), 120) : 12;
      until = Date.now() + months * 30 * DAY_MS;
    }
    try {
      const out = await accountsCall(env, "/grant", { email, sub, until, by: session.email });
      return json(out, out.ok ? 200 : 404);
    } catch {
      return json({ error: "Accounts store unavailable." }, 503);
    }
  }
  // Deletion on request ("delete my account" / "delete my bill" / "take my
  // name off that bill" emails). Admin-only; the privacy policy promises these
  // are done within 30 days, and this is how.
  if (path === "/api/admin/accounts/delete" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Bad request" }, 400);
    }
    const email = String(body.email || "").trim().toLowerCase().slice(0, 120);
    const sub = typeof body.sub === "string" ? body.sub.slice(0, 80) : "";
    if (!email && !sub) return json({ error: "Give an email or account id." }, 400);
    try {
      const out = await accountsCall(env, "/delete", { email, sub });
      return json(out, out.ok ? 200 : out.error === "No such account." ? 404 : 409);
    } catch {
      return json({ error: "Accounts store unavailable." }, 503);
    }
  }
  const billAdmin = path.match(/^\/api\/admin\/bills\/(delete|remove-person)$/);
  if (billAdmin && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Bad request" }, 400);
    }
    const billId = billIdFrom(body.bill);
    if (!billId) return json({ error: "Give a bill link or id." }, 400);
    const stub = env.BILL_ROOM.get(env.BILL_ROOM.idFromName(billId));
    const res = await stub.fetch("https://do/" + billAdmin[1], { method: "POST", body: JSON.stringify({ personId: body.personId }) });
    return json(await res.json(), res.status);
  }
  return json({ error: "Not found" }, 404);
}

async function verifyTurnstile(env, token, request) {
  if (!token) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET,
        response: token,
        remoteip: request.headers.get("CF-Connecting-IP") || undefined,
      }),
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

// ---------- Meter DO (singleton): daily per-IP + global caps ----------

const METER_LIMITS = {
  parse: { perIp: 10, global: 50 },
  create: { perIp: 30, global: 300 },
};

export class Meter {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  // Local dev (DEV=1 in .dev.vars): the integration suite creates ~20 bills a
  // run, so the create caps are 10× there. Parse caps stay put — scans cost money.
  limitsFor(kind) {
    const base = METER_LIMITS[kind];
    if (base && kind === "create" && this.env?.DEV === "1") return { perIp: base.perIp * 10, global: base.global * 10 };
    return base;
  }

  async fetch(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, message: "Bad meter request" }, 400);
    }
    const { kind, keys } = body;
    const limits = this.limitsFor(kind);
    if (!limits || !Array.isArray(keys) || keys.length < 1 || keys.length > 2 || keys.some((k) => typeof k !== "string")) {
      return json({ ok: false, message: "Bad meter request" }, 400);
    }

    const today = new Date().toISOString().slice(0, 10);
    let s = (await this.ctx.storage.get("counters")) || null;
    if (!s || s.date !== today) s = { date: today, global: {}, perIp: {} };

    const g = s.global[kind] || 0;
    if (g >= limits.global) {
      return json({ ok: false, message: "Splitty's daily budget is used up — resets at midnight UTC. You can still enter items manually." });
    }
    // Every principal (IP, and account when signed in) must be under its cap.
    for (const k of keys) {
      if ((s.perIp[kind + ":" + k] || 0) >= limits.perIp) {
        return json({ ok: false, message: "Daily limit reached — resets at midnight UTC. You can still enter items manually." });
      }
    }

    s.global[kind] = g + 1;
    for (const k of keys) {
      const key = kind + ":" + k;
      s.perIp[key] = (s.perIp[key] || 0) + 1;
    }
    await this.ctx.storage.put("counters", s);
    return json({ ok: true });
  }
}

// ---------- Accounts DO (singleton): users, tiers, usage, Stripe state ----------

const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7); // "2026-09" (UTC)

export class Accounts {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        sub TEXT PRIMARY KEY,
        email TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        pro_until INTEGER,
        pro_source TEXT,
        stripe_customer TEXT,
        stripe_subscription TEXT,
        stripe_status TEXT,
        month_key TEXT NOT NULL DEFAULT '',
        bills_month INTEGER NOT NULL DEFAULT 0,
        scans_month INTEGER NOT NULL DEFAULT 0,
        bills_total INTEGER NOT NULL DEFAULT 0,
        scans_total INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS users_email ON users(email);
      CREATE INDEX IF NOT EXISTS users_customer ON users(stripe_customer);
      CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
  }

  one(query, ...params) {
    return this.sql.exec(query, ...params).toArray()[0] || null;
  }

  // Find or create the row for a signed-in person. A Pro grant made by email
  // before they ever signed in lives under sub "email:<address>" and is
  // adopted on first sign-in.
  touch(sub, email, name, now) {
    email = String(email || "").toLowerCase().slice(0, 120);
    name = String(name || "").slice(0, 80);
    let row = this.one("SELECT * FROM users WHERE sub = ?", sub);
    if (!row && email) {
      const pending = this.one("SELECT * FROM users WHERE sub = ?", "email:" + email);
      if (pending) {
        this.sql.exec("UPDATE users SET sub = ? WHERE sub = ?", sub, "email:" + email);
        row = this.one("SELECT * FROM users WHERE sub = ?", sub);
      }
    }
    if (!row) {
      this.sql.exec("INSERT INTO users (sub, email, name, created_at, last_seen, month_key) VALUES (?, ?, ?, ?, ?, ?)", sub, email, name, now, now, monthKey(now));
      row = this.one("SELECT * FROM users WHERE sub = ?", sub);
    } else {
      // Month rollover resets the free counters.
      const mk = monthKey(now);
      if (row.month_key !== mk) this.sql.exec("UPDATE users SET month_key = ?, bills_month = 0, scans_month = 0 WHERE sub = ?", mk, sub);
      this.sql.exec("UPDATE users SET last_seen = ?, email = CASE WHEN ? != '' THEN ? ELSE email END, name = CASE WHEN ? != '' THEN ? ELSE name END WHERE sub = ?", now, email, email, name, name, sub);
      row = this.one("SELECT * FROM users WHERE sub = ?", sub);
    }
    return row;
  }

  entitlement(row, isAdmin, now) {
    // Grace past the period end only while Stripe still considers the
    // subscription alive (card retries); a cancellation ends Pro at once.
    const grace = ["active", "trialing", "past_due"].includes(row.stripe_status) ? PRO_GRACE_MS : 0;
    const stripeActive = row.pro_source === "stripe" && row.pro_until && row.pro_until + grace > now;
    const granted = row.pro_source === "admin" && row.pro_until && row.pro_until > now;
    const isPro = Boolean(isAdmin || stripeActive || granted);
    const source = isAdmin ? "admin-email" : stripeActive ? "stripe" : granted ? "admin" : null;
    return {
      tier: isPro ? "pro" : "free",
      isPro,
      proUntil: isPro && !isAdmin && row.pro_until && row.pro_until < FOREVER ? row.pro_until : null,
      proSource: source,
      stripeStatus: row.stripe_status || null,
      billsUsed: row.bills_month,
      billsLimit: isPro ? null : FREE_BILLS_PER_MONTH,
      billsLeft: isPro ? null : Math.max(0, FREE_BILLS_PER_MONTH - row.bills_month),
      canScan: isPro,
      hasStripeCustomer: Boolean(row.stripe_customer),
      stripeCustomer: row.stripe_customer || null, // stripped before it reaches a browser
      isAdmin: Boolean(isAdmin),
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    let body = {};
    if (request.method === "POST") {
      try {
        body = await request.json();
      } catch {
        return json({ error: "Bad request" }, 400);
      }
    }

    if (url.pathname === "/touch") {
      if (typeof body.sub !== "string" || !body.sub) return json({ error: "sub required" }, 400);
      const row = this.touch(body.sub, body.email, body.name, now);
      return json(this.entitlement(row, body.isAdmin, now));
    }

    if (url.pathname === "/consume") {
      if (typeof body.sub !== "string" || !body.sub) return json({ error: "sub required" }, 400);
      const row = this.touch(body.sub, body.email, body.name, now);
      const ent = this.entitlement(row, body.isAdmin, now);
      if (body.kind === "bill") {
        if (!ent.isPro && row.bills_month >= FREE_BILLS_PER_MONTH) {
          return json({ ok: false, code: "quota", message: `That's your ${FREE_BILLS_PER_MONTH} free bills for this month. Pro is unlimited — or wait for the 1st.`, entitlement: ent });
        }
        this.sql.exec("UPDATE users SET bills_month = bills_month + 1, bills_total = bills_total + 1 WHERE sub = ?", body.sub);
      } else if (body.kind === "scan") {
        if (!ent.canScan) return json({ ok: false, code: "pro", message: "Receipt scanning is a Pro feature.", entitlement: ent });
        this.sql.exec("UPDATE users SET scans_month = scans_month + 1, scans_total = scans_total + 1 WHERE sub = ?", body.sub);
      } else {
        return json({ error: "bad kind" }, 400);
      }
      return json({ ok: true, entitlement: this.entitlement(this.one("SELECT * FROM users WHERE sub = ?", body.sub), body.isAdmin, now) });
    }

    if (url.pathname === "/grant") {
      // Admin grant/revoke by sub or email. Email grants for people who have
      // not signed in yet are parked under sub "email:<address>".
      let row = body.sub ? this.one("SELECT * FROM users WHERE sub = ?", body.sub) : null;
      if (!row && body.email) row = this.one("SELECT * FROM users WHERE email = ? ORDER BY last_seen DESC LIMIT 1", body.email);
      if (!row && body.email) {
        const sub = "email:" + body.email;
        this.sql.exec("INSERT OR IGNORE INTO users (sub, email, created_at, last_seen, month_key) VALUES (?, ?, ?, ?, ?)", sub, body.email, now, now, monthKey(now));
        row = this.one("SELECT * FROM users WHERE sub = ?", sub);
      }
      if (!row) return json({ ok: false, error: "No such account." });
      const until = Number(body.until) || 0;
      if (until > now) this.sql.exec("UPDATE users SET pro_until = ?, pro_source = 'admin' WHERE sub = ?", until, row.sub);
      else if (row.pro_source === "admin" || !row.pro_source) this.sql.exec("UPDATE users SET pro_until = NULL, pro_source = NULL WHERE sub = ?", row.sub);
      else return json({ ok: false, error: "This Pro comes from a Stripe subscription — cancel it in Stripe instead." });
      return json({ ok: true, user: this.publicRow(this.one("SELECT * FROM users WHERE sub = ?", row.sub), now) });
    }

    if (url.pathname === "/stripe") {
      return json(this.applyStripeEvent(body.event, now));
    }

    if (url.pathname === "/delete") {
      // Erase an account record on request. Refused until any Stripe
      // subscription on it is cancelled: otherwise the person keeps paying for
      // a record that no longer exists.
      let row = body.sub ? this.one("SELECT * FROM users WHERE sub = ?", body.sub) : null;
      if (!row && body.email) row = this.one("SELECT * FROM users WHERE email = ? ORDER BY last_seen DESC LIMIT 1", body.email);
      if (!row) return json({ ok: false, error: "No such account." });
      if (row.stripe_subscription && !["canceled", "incomplete_expired"].includes(row.stripe_status)) {
        return json({ ok: false, error: "This account has a Stripe subscription that isn't cancelled — cancel it in Stripe first." });
      }
      this.sql.exec("DELETE FROM users WHERE sub = ?", row.sub);
      return json({ ok: true, deleted: this.publicRow(row, now) });
    }

    if (url.pathname === "/users") {
      const rows = this.sql.exec("SELECT * FROM users ORDER BY last_seen DESC LIMIT 500").toArray();
      return json({ users: rows.map((r) => this.publicRow(r, now)), freeBillsPerMonth: FREE_BILLS_PER_MONTH });
    }

    return json({ error: "Not found" }, 404);
  }

  publicRow(r, now) {
    const ent = this.entitlement(r, false, now);
    return {
      sub: r.sub, email: r.email, name: r.name, createdAt: r.created_at, lastSeen: r.last_seen,
      tier: ent.tier, proUntil: r.pro_until && r.pro_until < FOREVER ? r.pro_until : null, proForever: r.pro_until === FOREVER,
      proSource: r.pro_source, stripeStatus: r.stripe_status, hasStripeCustomer: Boolean(r.stripe_customer),
      billsMonth: r.bills_month, scansMonth: r.scans_month, billsTotal: r.bills_total, scansTotal: r.scans_total,
      pending: r.sub.startsWith("email:"),
    };
  }

  // Idempotent: each Stripe event id is applied once. Users are matched by the
  // sub we stamped into metadata / client_reference_id, then by customer id,
  // then by verified email as a last resort.
  applyStripeEvent(event, now) {
    if (!event || typeof event.id !== "string") return { applied: false, reason: "bad event" };
    if (this.one("SELECT id FROM stripe_events WHERE id = ?", event.id)) return { applied: false, reason: "duplicate" };
    this.sql.exec("INSERT INTO stripe_events (id, type, created_at) VALUES (?, ?, ?)", event.id, String(event.type).slice(0, 80), now);
    // Keep the idempotency table bounded.
    this.sql.exec("DELETE FROM stripe_events WHERE created_at < ?", now - 30 * DAY_MS);

    const obj = event.data?.object || {};
    const find = ({ sub, customer, subscription, email }) => {
      let row = null;
      if (sub) row = this.one("SELECT * FROM users WHERE sub = ?", sub);
      if (!row && customer) row = this.one("SELECT * FROM users WHERE stripe_customer = ? ORDER BY last_seen DESC LIMIT 1", customer);
      if (!row && subscription) row = this.one("SELECT * FROM users WHERE stripe_subscription = ? LIMIT 1", subscription);
      if (!row && email) row = this.one("SELECT * FROM users WHERE email = ? ORDER BY last_seen DESC LIMIT 1", String(email).toLowerCase());
      return row;
    };

    switch (event.type) {
      case "checkout.session.completed": {
        if (obj.mode && obj.mode !== "subscription") return { applied: false, reason: "not a subscription" };
        const sub = obj.client_reference_id || obj.metadata?.sub || null;
        const customer = typeof obj.customer === "string" ? obj.customer : obj.customer?.id;
        const subscription = typeof obj.subscription === "string" ? obj.subscription : obj.subscription?.id;
        const email = obj.customer_details?.email || obj.customer_email;
        const row = find({ sub, customer, subscription, email });
        if (!row) return { applied: false, reason: "no matching user" };
        // Provisional Pro until the subscription event carries the real period end.
        const provisional = Math.max(row.pro_source === "stripe" ? row.pro_until || 0 : 0, now + 35 * DAY_MS);
        this.sql.exec(
          "UPDATE users SET stripe_customer = COALESCE(?, stripe_customer), stripe_subscription = COALESCE(?, stripe_subscription), stripe_status = 'active', pro_source = 'stripe', pro_until = ? WHERE sub = ?",
          customer || null, subscription || null, provisional, row.sub,
        );
        return { applied: true, sub: row.sub };
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = obj.metadata?.sub || null;
        const customer = typeof obj.customer === "string" ? obj.customer : obj.customer?.id;
        const row = find({ sub, customer, subscription: obj.id });
        if (!row) return { applied: false, reason: "no matching user" };
        const status = String(obj.status || (event.type.endsWith("deleted") ? "canceled" : ""));
        // current_period_end moved onto subscription items in newer Stripe API versions.
        const periodEndSec = obj.current_period_end ?? obj.items?.data?.[0]?.current_period_end;
        const periodEnd = Number.isFinite(periodEndSec) ? periodEndSec * 1000 : now + 35 * DAY_MS;
        const keeps = ["active", "trialing", "past_due"].includes(status);
        const proUntil = event.type.endsWith("deleted") || !keeps ? Math.min(now - 1, row.pro_until || now) : periodEnd;
        this.sql.exec(
          "UPDATE users SET stripe_customer = COALESCE(?, stripe_customer), stripe_subscription = ?, stripe_status = ?, pro_source = 'stripe', pro_until = ? WHERE sub = ?",
          customer || null, obj.id || row.stripe_subscription, status, proUntil, row.sub,
        );
        return { applied: true, sub: row.sub, status };
      }
      default:
        return { applied: false, reason: "ignored type" };
    }
  }
}

// ---------- BillRoom DO: one per bill ----------

export class BillRoom {
  constructor(ctx) {
    this.ctx = ctx;
    // Per-connection soft limits. In-memory only — reset on hibernation wake,
    // which is fine: they exist to blunt floods, not to be perfect accounting.
    this.buckets = new Map(); // ws -> { count, resetAt }
    this.joinCounts = new Map(); // ws -> joins on this connection
    // "ping" from clients is answered without waking a hibernated DO.
    if (this.ctx.setWebSocketAutoResponse) {
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }
  }

  throttled(ws) {
    const now = Date.now();
    let b = this.buckets.get(ws);
    if (!b || now > b.resetAt) {
      b = { count: 0, resetAt: now + 10_000 };
      this.buckets.set(ws, b);
    }
    return ++b.count > 40; // 40 messages / 10s per connection
  }

  async loadBill() {
    const bill = await this.ctx.storage.get("bill");
    if (bill) normalizeClaims(bill); // legacy array claims → { personId: units }
    return bill;
  }

  async saveBill(bill) {
    bill.version = (bill.version || 0) + 1;
    bill.lastActivity = Date.now();
    await this.ctx.storage.put("bill", bill);
    await this.ctx.storage.setAlarm(Date.now() + EXPIRY_MS);
  }

  async alarm() {
    // 90 days without activity: the bill self-destructs.
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "expired");
      } catch {}
    }
    await this.ctx.storage.deleteAll();
  }

  broadcast(bill) {
    const msg = JSON.stringify({ type: "state", bill: publicBill(bill) });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {}
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      if (await this.loadBill()) return json({ error: "exists" }, 409);
      const bill = await request.json();
      await this.ctx.storage.put("bill", bill);
      await this.ctx.storage.setAlarm(Date.now() + EXPIRY_MS);
      return json({ ok: true });
    }

    if (url.pathname === "/state") {
      const bill = await this.loadBill();
      if (!bill) return json({ error: "Bill not found" }, 404);
      return json({ bill: publicBill(bill) });
    }

    // Operator tooling (only the admin API calls these): wipe the bill now
    // rather than at the 90-day alarm, or take one person off it.
    if (url.pathname === "/delete" && request.method === "POST") {
      const bill = await this.loadBill();
      if (!bill) return json({ ok: true, existed: false });
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1000, "expired");
        } catch {}
      }
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return json({ ok: true, existed: true });
    }
    if (url.pathname === "/remove-person" && request.method === "POST") {
      const bill = await this.loadBill();
      if (!bill) return json({ error: "Bill not found" }, 404);
      let personId;
      try {
        ({ personId } = await request.json());
      } catch {
        return json({ error: "Bad request" }, 400);
      }
      const person = bill.people.find((x) => x.id === personId);
      if (!person) return json({ error: "That person isn't on the bill." }, 404);
      removePersonFromBill(bill, person.id);
      await this.saveBill(bill);
      this.broadcast(bill);
      return json({ ok: true, removed: person.name });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      const bill = await this.loadBill();
      if (!bill) return json({ error: "Bill not found" }, 404);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify({ type: "state", bill: publicBill(bill) }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return json({ error: "Not found" }, 404);
  }

  // Class handler (Hibernation API) — never addEventListener. State is always
  // re-read from storage because in-memory state vanishes on hibernation.
  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 100_000) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const send = (o) => {
      try {
        ws.send(JSON.stringify(o));
      } catch {}
    };
    if (this.throttled(ws)) {
      return send({ type: "error", message: "Slow down a little — too many changes at once." });
    }

    const bill = await this.loadBill();
    if (!bill) {
      send({ type: "error", message: "This bill no longer exists." });
      try {
        ws.close(1000, "gone");
      } catch {}
      return;
    }

    const tokenHash = typeof msg.token === "string" && msg.token ? await sha256(msg.token) : null;
    const isCreator = tokenHash !== null && tokenHash === bill.creatorTokenHash;
    const canActFor = (personId) => {
      if (isCreator) return true;
      const p = bill.people.find((x) => x.id === personId);
      return Boolean(p && tokenHash && tokenHash === p.tokenHash);
    };

    let changed = false;

    switch (msg.type) {
      case "join": {
        if (bill.locked) return send({ type: "error", message: "This bill is locked." });
        const joins = (this.joinCounts.get(ws) || 0) + 1;
        this.joinCounts.set(ws, joins);
        if (joins > 5) return send({ type: "error", message: "Too many joins from this connection." });
        const name = String(msg.name || "").trim().slice(0, 40);
        if (!name) return send({ type: "error", message: "Enter a name first." });
        if (bill.people.length >= MAX_PEOPLE) return send({ type: "error", message: "This bill already has the maximum number of people." });
        const token = randomToken();
        const person = {
          id: "p" + randomToken().slice(0, 10),
          name,
          color: COLORS[bill.people.length % COLORS.length],
          tokenHash: await sha256(token),
        };
        bill.people.push(person);
        // The creator joining as a person marks who the table pays back, so
        // their own card gets no Pay button and the summary can name them.
        if (isCreator) bill.creatorPersonId = person.id;
        changed = true;
        send({ type: "joined", personId: person.id, token });
        break;
      }

      case "set_claim": {
        // Idempotent by design: a replayed set_claim is a no-op, never an inversion.
        // `units` (0 = unclaim) is the number of this line the person had;
        // `claimed: true/false` is the older form and means "1 unit" / "none".
        if (bill.locked && !isCreator) return send({ type: "error", message: "This bill is locked." });
        const { itemId, personId } = msg;
        const item = bill.items.find((i) => i.id === itemId);
        if (!item) return send({ type: "error", message: "That item no longer exists." });
        if (!bill.people.some((p) => p.id === personId)) return send({ type: "error", message: "That person no longer exists." });
        if (!canActFor(personId)) return send({ type: "error", message: "You can only claim items for yourself." });
        const entry = bill.claims[itemId] || {};
        const current = entry[personId] || 0;
        let units;
        if (Number.isInteger(msg.units)) units = msg.units;
        else if ("claimed" in msg) units = msg.claimed ? (current || 1) : 0;
        else return send({ type: "error", message: "Say how many you had." });
        if (units < 0 || units > MAX_UNITS) return send({ type: "error", message: "That's not a sensible number of items." });
        units = Math.min(units, item.qty || 1); // nobody had more than the line holds
        if (units === current) break;
        if (units > 0) {
          bill.claims[itemId] = { ...entry, [personId]: units };
        } else {
          const next = { ...entry };
          delete next[personId];
          if (Object.keys(next).length) bill.claims[itemId] = next;
          else delete bill.claims[itemId];
        }
        changed = true;
        break;
      }

      case "rename_person": {
        if (bill.locked && !isCreator) return send({ type: "error", message: "This bill is locked." });
        const name = String(msg.name || "").trim().slice(0, 40);
        if (!name) return send({ type: "error", message: "Enter a name first." });
        const p = bill.people.find((x) => x.id === msg.personId);
        if (!p) return send({ type: "error", message: "That person no longer exists." });
        if (!canActFor(p.id)) return send({ type: "error", message: "Not allowed." });
        p.name = name;
        changed = true;
        break;
      }

      case "remove_person": {
        if (bill.locked && !isCreator) return send({ type: "error", message: "This bill is locked." });
        const p = bill.people.find((x) => x.id === msg.personId);
        if (!p) break; // already gone — idempotent
        if (!canActFor(p.id)) return send({ type: "error", message: "Not allowed." });
        removePersonFromBill(bill, p.id);
        changed = true;
        break;
      }

      case "set_pay": {
        // Creator publishes (or clears) where the table should pay them back.
        if (!isCreator) return send({ type: "error", message: "Only the bill creator can set payment details." });
        const res = cleanPay(msg.pay);
        if (res.error) return send({ type: "error", message: res.error });
        if (JSON.stringify(res.value) !== JSON.stringify(bill.pay || {})) {
          bill.pay = res.value;
          changed = true;
        }
        break;
      }

      case "set_paid": {
        // Settling up happens after the bill is locked, so lock doesn't apply.
        // Idempotent like set_claim: marking paid twice is a no-op.
        const p = bill.people.find((x) => x.id === msg.personId);
        if (!p) return send({ type: "error", message: "That person no longer exists." });
        if (!canActFor(p.id)) return send({ type: "error", message: `Only ${p.name} (or the creator) can mark that.` });
        const paid = Boolean(msg.paid);
        bill.paid = bill.paid || {};
        if (paid && !bill.paid[p.id]) {
          bill.paid[p.id] = Date.now();
          changed = true;
        } else if (!paid && bill.paid[p.id]) {
          delete bill.paid[p.id];
          changed = true;
        }
        break;
      }

      case "edit_bill": {
        if (!isCreator) return send({ type: "error", message: "Only the bill creator can edit it." });
        const fields = cleanBillFields(msg.bill || {});
        if (fields.error) return send({ type: "error", message: fields.error });
        bill.restaurant = fields.restaurant;
        bill.items = fields.items;
        bill.taxCents = fields.taxCents;
        bill.tip = fields.tip;
        // Claims on deleted items go; units above a reduced qty are clamped.
        const qtyById = new Map(bill.items.map((i) => [i.id, i.qty || 1]));
        for (const [itemId, entry] of Object.entries(bill.claims)) {
          const qty = qtyById.get(itemId);
          if (!qty) { delete bill.claims[itemId]; continue; }
          for (const pid of Object.keys(entry)) if (entry[pid] > qty) entry[pid] = qty;
        }
        changed = true;
        break;
      }

      case "lock": {
        if (!isCreator) return send({ type: "error", message: "Only the bill creator can lock it." });
        const locked = Boolean(msg.locked);
        if (bill.locked !== locked) {
          bill.locked = locked;
          changed = true;
        }
        break;
      }

      default:
        return; // unknown message — ignore
    }

    if (changed) {
      await this.saveBill(bill);
      this.broadcast(bill);
    }
  }

  async webSocketClose(ws) {
    this.buckets.delete(ws);
    this.joinCounts.delete(ws);
  }
  async webSocketError(ws) {
    this.buckets.delete(ws);
    this.joinCounts.delete(ws);
  }
}
