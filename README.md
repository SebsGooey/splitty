# Splitty 🧾

Snap a receipt, share a link, split the bill — live on every phone at the table.

**Live:** https://splitty.<your-subdomain>.workers.dev *(original Moxies demo: [/moxies.html](public/moxies.html))*

## How it works

1. **Create a bill** — snap a photo of the receipt (Claude vision reads the items; you review and fix the draft) or type items in manually.
2. **Share the link** — the URL is the access: no accounts, no app. Anyone with it can join with their name.
3. **Claim items** — tap what you had; shared items split evenly. Every phone viewing the bill updates in realtime over WebSockets.
4. Each person's total includes their proportional share of tax and tip, exact to the cent (largest-remainder allocation — the per-person totals always sum to the bill total).

Bills self-delete after 90 days of inactivity. Receipt images are never stored.

## Architecture

One Cloudflare Workers project, no build step, no framework:

- **`public/`** — static vanilla-JS frontend (create page, bill page) served via Workers Static Assets.
- **`src/worker.js`** — the Worker (routing, bill creation, receipt parsing via the Anthropic API) plus two Durable Objects:
  - **`BillRoom`** (one per bill) — SQLite-backed DO that is simultaneously the database, the write serializer (single-threaded actor: simultaneous taps can't conflict), and the WebSocket hub (Hibernation API; full-state versioned broadcasts).
  - **`Meter`** (singleton) — daily per-IP and global rate caps on the endpoints that cost money.
- **Security model** — capability URLs (128-bit bill IDs); hashed creator + per-person tokens; idempotent `set_claim` intents (replays are no-ops); same-origin enforcement on POSTs; per-connection message throttles; CSP + no-referrer + noindex headers.

## Develop

```bash
npm install
npm run dev        # http://localhost:8787
```

## Deploy

```bash
npx wrangler login
npm run deploy
```

Then enable receipt scanning (optional — manual entry works without it):

```bash
npx wrangler secret put ANTHROPIC_API_KEY   # paste your key at the prompt
```

Cost control: parse requests are capped at 10/IP/day and 50/day globally; set a monthly spend limit on the Anthropic workspace as the external hard cap. Model defaults to `claude-opus-5` (~1–3¢/receipt); set `PARSE_MODEL = "claude-haiku-4-5"` in `wrangler.toml` `[vars]` for the cheap toggle. Optionally set `TURNSTILE_SITE_KEY` (vars) + `TURNSTILE_SECRET` (secret) to add a bot check to scanning.
