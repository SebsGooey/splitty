# Splitty 🧾

Snap a receipt, share a link, split the bill — live on every phone at the table.

**Live:** https://splitty.<your-subdomain>.workers.dev *(original Moxies demo: [/moxies.html](public/moxies.html))*

## How it works

1. **Create a bill** — snap a photo of the receipt (Claude vision reads the items; you review and fix the draft) or type items in manually.
2. **Share the link** — the URL is the access: no accounts, no app. Anyone with it can join with their name.
3. **Claim items** — tap what you had; shared items split evenly. Every phone viewing the bill updates in realtime over WebSockets.
4. Each person's total includes their proportional share of tax and tip, exact to the cent (largest-remainder allocation — the per-person totals always sum to the bill total).
5. **Settle up** — the creator adds their Venmo / Cash App / PayPal.Me once (remembered on their device); every person's card gets **Pay** buttons that open the app with their exact amount filled in, and people tick themselves off as **paid** (the creator can too). **Copy summary** puts the whole split — who owes what, who's paid, where to pay — on the clipboard (or the share sheet on phones) for the group chat.

Bills self-delete after 90 days of inactivity. Receipt images are never stored.

## Architecture

One Cloudflare Workers project, no build step, no framework:

- **`public/`** — static vanilla-JS frontend (create page, bill page, shared `pay.js` settle-up helpers) served via Workers Static Assets.
- **`src/worker.js`** — the Worker (routing, bill creation, receipt parsing via the Anthropic API) plus two Durable Objects:
  - **`BillRoom`** (one per bill) — SQLite-backed DO that is simultaneously the database, the write serializer (single-threaded actor: simultaneous taps can't conflict), and the WebSocket hub (Hibernation API; full-state versioned broadcasts).
  - **`Meter`** (singleton) — daily per-IP and global rate caps on the endpoints that cost money.
- **Security model** — capability URLs (128-bit bill IDs); hashed creator + per-person tokens; idempotent `set_claim` / `set_paid` intents (replays are no-ops); payment handles validated per network server-side and rendered only as deep links; same-origin enforcement on POSTs; per-connection message throttles; CSP + no-referrer + noindex headers.

## Develop

```bash
npm install
cp .dev.vars.example .dev.vars   # local SESSION_SECRET so the sign-in gate has a key
npm run dev        # http://localhost:8787
```

## Test

Integration tests run against the live `npm run dev` server, so Durable Objects, WebSockets and asset routing are the real thing:

```bash
npm test           # 16 tests: auth, create, realtime claims/locks/edits, settle up, throttles
npm run test:meter # also trips the daily per-IP create cap (burns local budget — run last)
npm run dev:reset  # clear local Durable Object state, then restart npm run dev
```

The tests mint a session cookie with the same HMAC scheme the Worker uses (`SESSION_SECRET` from `.dev.vars`), so the signed-in path is exercised without touching Google.

## Deploy

Pushes to `main` deploy automatically — the Worker is connected to this repo through Cloudflare Workers Builds (Settings → Builds; deploy command `npx wrangler deploy`). Other branches get preview builds. Manual deploy still works:

```bash
npx wrangler login
npm run deploy
```

Then enable receipt scanning (optional — manual entry works without it):

```bash
npx wrangler secret put ANTHROPIC_API_KEY   # paste your key at the prompt
```

Cost control: parse requests are capped at 10/IP/day and 50/day globally; set a monthly spend limit on the Anthropic workspace as the external hard cap. Model defaults to `claude-opus-5` (~1–3¢/receipt); set `PARSE_MODEL = "claude-haiku-4-5"` in `wrangler.toml` `[vars]` for the cheap toggle. Optionally set `TURNSTILE_SITE_KEY` (vars) + `TURNSTILE_SECRET` (secret) to add a bot check to scanning.
