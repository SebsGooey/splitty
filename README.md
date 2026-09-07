# Splitty 🧾

Snap a receipt, share a link, split the bill — live on every phone at the table.

**Live:** https://splitty.<your-subdomain>.workers.dev *(original Moxies demo: [/moxies.html](public/moxies.html))*

## How it works

1. **Create a bill** — snap a photo of the receipt (Claude vision reads the items; you review and fix the draft) or type items in manually.
2. **Share the link** — the URL is the access: no accounts, no app. Anyone with it can join with their name.
3. **Claim items** — tap what you had; shared items split evenly. Every phone viewing the bill updates in realtime over WebSockets.
4. Each person's total includes their proportional share of tax and tip, exact to the cent (largest-remainder allocation — the per-person totals always sum to the bill total).
5. **Settle up** — the creator adds their Venmo / Cash App / PayPal.Me once (remembered on their device); every person's card gets **Pay** buttons that open the app with their exact amount filled in, and people tick themselves off as **paid** (the creator can too). **Copy summary** puts the whole split — who owes what, who's paid, where to pay — on the clipboard (or the share sheet on phones) for the group chat.

6. **Quantities** — a line like "3 × Beer $18" lets each person say how many were theirs (− / +); cost splits by units and anything nobody claimed stays unclaimed.

Bills self-delete after 90 days of inactivity. Receipt images are never stored.

## Accounts and tiers

Joining a bill via its link never needs an account. Creating bills and scanning receipts need a Google sign-in, and sit behind two tiers:

| | Free | Pro ($2.99 / month) |
|---|---|---|
| Create bills | 3 a month (resets on the 1st, UTC) | unlimited* |
| Receipt scanning (Claude vision) | — | yes* |
| Join / claim / settle via link | free, no account | free, no account |

\*still under the daily abuse caps (`METER_LIMITS`).

Pro comes from a Stripe subscription, an admin grant, or being listed in `ADMIN_EMAILS`. Accounts, usage counters and Stripe state live in the `Accounts` Durable Object (SQLite) — no external database. The Stripe customer id never leaves the server.

### Setup

1. **Admins** — in Cloudflare → Workers & Pages → splitty → Settings → Variables and Secrets, add `ADMIN_EMAILS` (plain text is fine; `keep_vars = true` in `wrangler.toml` keeps dashboard variables across deploys) with the Google email(s) that should be Pro for free and see **/admin.html** (list accounts, grant/revoke Pro, grant by email before someone has signed in).
2. **Stripe** (optional until you want to charge):
   - Create a product with a recurring price — $2.99 / month — and copy its `price_…` id → `STRIPE_PRICE_ID` (variable).
   - Developers → API keys → secret key → `STRIPE_SECRET_KEY` (secret).
   - Developers → Webhooks → add endpoint `https://<your-worker>/api/stripe/webhook` with events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` → signing secret → `STRIPE_WEBHOOK_SECRET` (secret).
   - Optional: `PRO_PRICE_LABEL` if the price isn't $2.99 / month.
   - Enable the Customer Portal in Stripe (Settings → Billing → Customer portal) so "manage subscription" works.

   Until all three `STRIPE_*` values exist the upgrade button reads "Pro — coming soon" and only admin grants can make someone Pro. Webhooks are signature-verified (5-minute tolerance), idempotent by event id, and tolerate both the classic and the 2025+ (`items.data[0].current_period_end`) subscription shapes. A cancelled subscription drops to Free at once; `past_due` keeps Pro for a 3-day grace while Stripe retries the card.

## Architecture

One Cloudflare Workers project, no build step, no framework:

- **`public/`** — static vanilla-JS frontend (create page, bill page, admin page, shared `pay.js` / `money.js`) served via Workers Static Assets.
- **`src/worker.js`** — the Worker (routing, bill creation, receipt parsing via the Anthropic API) plus two Durable Objects:
  - **`BillRoom`** (one per bill) — SQLite-backed DO that is simultaneously the database, the write serializer (single-threaded actor: simultaneous taps can't conflict), and the WebSocket hub (Hibernation API; full-state versioned broadcasts).
  - **`Meter`** (singleton) — daily per-IP and global rate caps on the endpoints that cost money.
  - **`Accounts`** (singleton, SQLite) — sign-in accounts, free-tier usage per month, Pro entitlements (Stripe / admin), Stripe webhook idempotency.
- **Security model** — capability URLs (128-bit bill IDs); hashed creator + per-person tokens; idempotent `set_claim` / `set_paid` intents (replays are no-ops); payment handles validated per network server-side and rendered only as deep links; same-origin enforcement on POSTs; per-connection message throttles; CSP + no-referrer + noindex headers.

## Develop

```bash
npm install
cp .dev.vars.example .dev.vars   # local SESSION_SECRET (+ ADMIN_EMAILS / STRIPE_WEBHOOK_SECRET for the tier tests)
npm run dev        # http://localhost:8787
```

## Test

Integration tests run against the live `npm run dev` server, so Durable Objects, WebSockets and asset routing are the real thing:

```bash
npm test           # 21 tests: auth, create, realtime claims/locks/edits, quantities, settle up, tiers, admin, Stripe webhooks, throttles
npm run test:meter # also trips the daily per-IP create cap (burns local budget — run last)
npm run dev:reset  # clear local Durable Object state, then restart npm run dev
```

The tests mint a session cookie with the same HMAC scheme the Worker uses (`SESSION_SECRET` from `.dev.vars`), so the signed-in path is exercised without touching Google; the default test identity is `admin@example.com` (set `ADMIN_EMAILS=admin@example.com` locally so it is Pro and never trips the free quota). Stripe webhook tests sign their own payloads with `STRIPE_WEBHOOK_SECRET`. Set a dummy `ANTHROPIC_API_KEY` locally to exercise the scan gate.

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
