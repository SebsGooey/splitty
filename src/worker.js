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

function publicBill(bill) {
  return {
    ...bill,
    creatorTokenHash: undefined,
    people: bill.people.map(({ tokenHash, ...p }) => p),
  };
}

// ---------- Worker (router) ----------

// Browsers always send Origin on cross-site POSTs; a mismatched Origin means a
// drive-by page is spending our Anthropic budget or creating bills via a
// visitor's browser. Non-browser clients (no Origin header) are not CSRF.
function crossOrigin(request, url) {
  const origin = request.headers.get("Origin");
  return Boolean(origin && origin !== url.origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === "POST" && path.startsWith("/api/") && crossOrigin(request, url)) {
        return json({ error: "Cross-origin requests are not allowed." }, 403);
      }
      if (path === "/api/config") {
        return json({
          parseEnabled: Boolean(env.ANTHROPIC_API_KEY),
          turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
        });
      }

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
        const res = await env.ASSETS.fetch(new Request(new URL("/bill.html", url.origin)));
        const headers = new Headers(res.headers);
        headers.set("referrer-policy", "no-referrer");
        headers.set("x-robots-tag", "noindex");
        return new Response(res.body, { status: res.status, headers });
      }

      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: "Server error" }, 500);
    }
  },
};

async function meterCheck(env, request, kind) {
  try {
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    const stub = env.METER.get(env.METER.idFromName("global"));
    const res = await stub.fetch("https://do/check", {
      method: "POST",
      body: JSON.stringify({ kind, ipHash: (await sha256(ip)).slice(0, 16) }),
    });
    return await res.json();
  } catch {
    // If the meter itself breaks, fail open for creates but closed for paid parses.
    return { ok: kind !== "parse", message: "Rate limiter unavailable — try again shortly." };
  }
}

async function createBill(request, env) {
  // Validate before metering so malformed requests can't burn the daily budget.
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }
  const fields = cleanBillFields(body);
  if (fields.error) return json({ error: fields.error }, 400);

  const meter = await meterCheck(env, request, "create");
  if (!meter.ok) return json({ error: meter.message }, 429);

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
  const meter = await meterCheck(env, request, "parse");
  if (!meter.ok) return json({ error: meter.message }, 429);

  // effort and server-side fallbacks are Opus-5-tier request features; sending
  // them to e.g. claude-haiku-4-5 is an upstream 400.
  const model = env.PARSE_MODEL || "claude-opus-5";
  const isOpus5Tier = /^claude-(opus-5|fable-5|mythos-5)/.test(model);
  const headers = {
    "content-type": "application/json",
    "x-api-key": env.ANTHROPIC_API_KEY,
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
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    req.fallbacks = "default";
    req.output_config.effort = "medium";
  }

  const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(req),
  });

  if (!apiRes.ok) {
    return json({ error: `Receipt scanning failed (upstream ${apiRes.status}). Try again or enter items manually.` }, 502);
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
  return json({ draft });
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
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, message: "Bad meter request" }, 400);
    }
    const { kind, ipHash } = body;
    const limits = METER_LIMITS[kind];
    if (!limits || typeof ipHash !== "string") return json({ ok: false, message: "Bad meter request" }, 400);

    const today = new Date().toISOString().slice(0, 10);
    let s = (await this.ctx.storage.get("counters")) || null;
    if (!s || s.date !== today) s = { date: today, global: {}, perIp: {} };

    const g = s.global[kind] || 0;
    const key = kind + ":" + ipHash;
    const mine = s.perIp[key] || 0;

    if (mine >= limits.perIp) {
      return json({ ok: false, message: "Daily limit reached for your connection — resets at midnight UTC. You can still enter items manually." });
    }
    if (g >= limits.global) {
      return json({ ok: false, message: "Splitty's daily budget is used up — resets at midnight UTC. You can still enter items manually." });
    }

    s.global[kind] = g + 1;
    s.perIp[key] = mine + 1;
    await this.ctx.storage.put("counters", s);
    return json({ ok: true });
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
    return this.ctx.storage.get("bill");
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
        changed = true;
        send({ type: "joined", personId: person.id, token });
        break;
      }

      case "set_claim": {
        // Idempotent by design: a replayed set_claim is a no-op, never an inversion.
        if (bill.locked && !isCreator) return send({ type: "error", message: "This bill is locked." });
        const { itemId, personId, claimed } = msg;
        if (!bill.items.some((i) => i.id === itemId)) return send({ type: "error", message: "That item no longer exists." });
        if (!bill.people.some((p) => p.id === personId)) return send({ type: "error", message: "That person no longer exists." });
        if (!canActFor(personId)) return send({ type: "error", message: "You can only claim items for yourself." });
        const arr = bill.claims[itemId] || [];
        const has = arr.includes(personId);
        if (claimed && !has) {
          bill.claims[itemId] = [...arr, personId];
          changed = true;
        } else if (!claimed && has) {
          const next = arr.filter((x) => x !== personId);
          if (next.length) bill.claims[itemId] = next;
          else delete bill.claims[itemId];
          changed = true;
        }
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
        bill.people = bill.people.filter((x) => x.id !== p.id);
        for (const [itemId, arr] of Object.entries(bill.claims)) {
          const next = arr.filter((x) => x !== p.id);
          if (next.length) bill.claims[itemId] = next;
          else delete bill.claims[itemId];
        }
        changed = true;
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
        const validItems = new Set(bill.items.map((i) => i.id));
        for (const itemId of Object.keys(bill.claims)) {
          if (!validItems.has(itemId)) delete bill.claims[itemId];
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
