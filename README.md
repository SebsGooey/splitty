# Splitty 🧾

Snap a receipt, share a link, split the bill — live on every phone at the table.

**Live:** https://splitty.cc *(original Moxies demo: [/moxies.html](public/moxies.html))*

## How it works

1. **Create a bill** — snap a photo of the receipt (Claude vision reads the items; you review and fix the draft) or type items in manually.
2. **Share the link** — the URL is the access: no accounts, no app. Anyone with it can join with their name.
3. **Claim items** — tap what you had; shared items split evenly. Every phone viewing the bill updates in realtime over WebSockets.
4. Each person's total includes their proportional share of tax and tip, exact to the cent (largest-remainder allocation — the per-person totals always sum to the bill total).
5. **Settle up** — the creator adds their Venmo / Cash App / PayPal.Me once (remembered on their device); every person's card gets **Pay** buttons that open the app with their exact amount filled in, and people tick themselves off as **paid** (the creator can too). **Copy summary** puts the whole split — who owes what, who's paid, where to pay — on the clipboard (or the share sheet on phones) for the group chat.

6. **Quantities** — a line like "3 × Beer $18" lets each person say how many were theirs (− / +); cost splits by units and anything nobody claimed stays unclaimed.

Bills self-delete after 90 days of inactivity. Receipt images are never stored.

Visitors can try `/demo` before signing in: a fictional bill with shared items, exact totals and no API writes or saved data. Guests who finish their own share see an invitation to host their next bill.

Financial changes clear paid acknowledgements and show a reminder to check payments already sent. A new paid acknowledgement must match the bill version the person saw.

## Accounts and tiers

Joining a bill via its link never needs an account. Creating bills and scanning receipts need a Google sign-in, and sit behind two tiers:

| | Free | Pro ($2.99 / month) |
|---|---|---|
| Create manual bills | 3 per calendar month | unlimited* |
| Receipt scanning (Claude vision) | — | 30 attempts per calendar month* |
| Join / claim / settle via link | free, no account | free, no account |

Monthly counts reset on the 1st at midnight UTC, independently of the subscription renewal date, with no rollover. A validated scan consumes an attempt immediately before it is sent to Anthropic, including failed or unreadable results. Sign-in, validation and daily-cap rejections before processing do not consume the monthly scan allowance. At the scan limit, Pro can still create bills manually.

\*Daily safety caps (`METER_LIMITS`) still apply: 10 scan attempts and 30 bill creations per IP/account, plus 50 scan attempts and 300 bill creations across the site. Daily counts reset at midnight UTC. Admins have no monthly scan limit but retain daily safety caps.

Only the $2.99 monthly subscription is offered at launch. It renews automatically until cancelled; friends never need Pro to join, claim or settle. See [pricing rationale and cost assumptions](docs/pricing.md).

Pro comes from a Stripe subscription, an admin grant, or being listed in `ADMIN_EMAILS`. Accounts, usage counters and Stripe state live in the `Accounts` Durable Object (SQLite) — no external database. The Stripe customer id never leaves the server.

### Setup

1. **Admins** — in Cloudflare → Workers & Pages → splitty → Settings → Variables and Secrets, add `ADMIN_EMAILS` (plain text is fine; `keep_vars = true` in `wrangler.toml` keeps dashboard variables across deploys) with the Google email(s) that should be Pro for free and see **/admin.html** (list accounts, grant/revoke Pro, grant by email before someone has signed in, and handle privacy requests: delete an account record, delete a bill, or take one person off a bill).
2. **Stripe** (optional until you want to charge):
   - Create a product with a recurring price — $2.99 / month — and set its ids as `STRIPE_PRODUCT_ID` and `STRIPE_PRICE_ID` (variables).
   - Use a restricted Stripe API key with the permissions required by checkout, subscriptions and the customer portal → `STRIPE_SECRET_KEY` (secret). Never put a key in the repo or the frontend.
   - Developers → Webhooks → add endpoint `https://splitty.cc/api/stripe/webhook`, using API version `2026-08-26.dahlia`, with `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required` and `invoice.voided` → signing secret → `STRIPE_WEBHOOK_SECRET` (secret).
   - Optional: `PRO_PRICE_LABEL` if the price isn't $2.99 / month.
   - Use a dedicated Splitty Customer Portal configuration, set `STRIPE_PORTAL_CONFIGURATION_ID`, and configure cancellation at the end of the paid period so "manage subscription" works without changing another product's portal.

3. **Legal pages** — `/terms` and `/privacy` (files `public/terms.html` and `public/privacy.html`; the asset layer 307s the `.html` form to the extensionless URL) are linked from the create and bill page footers. Checkout includes Splitty's terms beside the subscribe button, and the dedicated portal configuration stores Splitty's terms/privacy URLs. Keep these app-specific on the shared Stripe account. Google OAuth consent-screen app-domain links should use `https://splitty.cc/terms` and `https://splitty.cc/privacy`.

   Until `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` and `STRIPE_WEBHOOK_SECRET` exist, the upgrade button reads "Pro — coming soon" and only admin grants can make someone Pro. Webhooks are signature-verified (5-minute tolerance), idempotent by event id, and reconcile current Stripe subscription/invoice state instead of trusting event order. Matching uses account/customer/subscription references, never email alone. Checkout attempts are retained for safe retries; existing subscriptions go to management instead of creating a duplicate. A subscription scheduled to cancel keeps Pro through its paid period; the create page shows "ends" instead of "renews". An ended subscription drops to Free; `past_due` keeps Pro for a 3-day grace while Stripe retries the card.

### Launch configuration and support

The following live Stripe resources were prepared and checked on September 10, 2026. This records configuration readiness; it does not confirm deployment of this checkout or a completed customer payment.

| Setting | Value |
|---|---|
| `STRIPE_PRODUCT_ID` | `splitty_pro` |
| `STRIPE_PRICE_ID` | `price_1UDyEjAFXh9zNtLQBeho5jk1` — USD 299 cents/month |
| `STRIPE_PORTAL_CONFIGURATION_ID` | `bpc_1UDyYmAFXh9zNtLQwli28ae0` |
| Stripe API version | `2026-08-26.dahlia` |

Live API checks successfully created an unpaid Checkout session and a session for the dedicated customer portal. Both pages were checked in the browser; Checkout showed USD $2.99/month, the 30-attempt allowance and renewal terms. The unpaid session was expired and its temporary customer deleted; no subscription or customer charge was created. No Stripe Tax registrations are configured and automatic tax is off; these are account settings, not a determination of tax obligations.

Support mail to `hello@splitty.cc` is configured in Cloudflare Email Routing to forward to `indranet.technologies@gmail.com`. Handle support from that business Gmail inbox. The verified Gmail filter matches `to:(hello@splitty.cc)`, applies the `Splitty Support` label, and skips the main inbox without marking messages read. Replies use the business Gmail address until a dedicated SMTP mailbox or authenticated sending service is configured; forwarding alone does not enable sending as `hello@splitty.cc`.

## Architecture

One Cloudflare Workers project, no build step, no framework:

- **`public/`** — static vanilla-JS frontend (create page, bill page, admin page, terms + privacy pages, shared `pay.js` / `money.js`, web-app manifest + icons so it can be added to a home screen) served via Workers Static Assets.
- **`src/worker.js`** — the Worker (routing, bill creation, receipt parsing via the Anthropic API) plus three Durable Objects:
  - **`BillRoom`** (one per bill) — SQLite-backed DO that is simultaneously the database, the write serializer (single-threaded actor: simultaneous taps can't conflict), and the WebSocket hub (Hibernation API; full-state versioned broadcasts).
  - **`Meter`** (singleton) — daily per-IP, per-account (when signed in) and global rate caps on the endpoints that cost money.
  - **`Accounts`** (singleton, SQLite) — sign-in accounts, monthly bill/scan-attempt counters, Pro entitlements (Stripe / admin), Stripe webhook idempotency.
- **Link previews** — the Worker injects Open Graph tags into each bill page (bill name, item and people counts; never amounts or names) so a pasted link shows a card in iMessage, WhatsApp, Slack and the like; the static pages carry fixed tags; the card image is `public/icons/og-card.png` (1200×630).
- **Security model** — capability URLs (128-bit bill IDs); hashed creator + per-person tokens; idempotent `set_claim` / `set_paid` intents (replays are no-ops); payment handles validated per network server-side and rendered only as deep links; same-origin enforcement on POSTs; per-connection message throttles; CSP + no-referrer + noindex headers.

## Develop

Use Node.js 24 or later. The billing and scan unit suites use the built-in `node:sqlite` module.

```bash
npm install
cp .dev.vars.example .dev.vars   # local SESSION_SECRET (+ ADMIN_EMAILS / STRIPE_WEBHOOK_SECRET for the tier tests)
npm run dev        # http://localhost:8787
```

## Test

The current baseline is **106 passing local checks**: 26 integration, 17 billing, 17 receipt-scanning, 22 onboarding and 24 settlement tests. Integration tests run against the local `npm run dev` server, so Durable Objects, WebSockets and asset routing are the real thing. Billing and scan unit tests use Node.js 24's SQLite implementation with fake Stripe/Anthropic responses; they do not call the paid APIs.

```bash
npm test             # 26 integration tests; keep npm run dev running separately
npm run test:billing # 17 billing tests; no dev server needed
npm run test:scans   # 17 receipt-scanning tests; no dev server needed
npm run test:onboarding # 22 demo and guest-invitation checks; offline
npm run test:settlement # 24 paid-state and concurrency checks; offline
npm run test:meter   # also trips the daily per-IP create cap (burns local budget — run last)
npm run dev:reset    # clear local Durable Object state, then restart npm run dev
```

The tests mint a session cookie with the same HMAC scheme the Worker uses (`SESSION_SECRET` from `.dev.vars`), so the signed-in path is exercised without touching Google; the default test identity is `admin@example.com` (set `ADMIN_EMAILS=admin@example.com` locally so it is Pro and never trips the free quota). Stripe webhook tests sign their own payloads with `STRIPE_WEBHOOK_SECRET`. Set a dummy `ANTHROPIC_API_KEY` locally to exercise the scan gate. `DEV=1` (also in the example) multiplies the daily create caps by 10 locally so a day of repeated runs doesn't hit the 30/IP cap — never set it in production.

See [days 1–3 verification and isolated Stripe sandbox setup](docs/days-1-3-verification.md) for browser checks, real Stripe results, and the remaining scheduled-renewal verification. The sandbox fixture is separate from production and rejects live keys. The standard integration suite refuses remote targets and enabled billing before it can mutate data.

## Deploy

Pushes to `main` deploy automatically — the Worker is connected to this repo through Cloudflare Workers Builds (Settings → Builds; deploy command `npx wrangler deploy`). Other branches get preview builds. The Worker serves `splitty.cc` and `www.splitty.cc` as custom domains (Workers & Pages → splitty → Domains); `CANONICAL_HOST` in `wrangler.toml` makes page loads on `www.` or the `*.workers.dev` URL redirect to `https://splitty.cc`. Google sign-in needs every origin listed under the OAuth client's Authorized JavaScript origins. Manual deploy still works:

```bash
npx wrangler login
npm run deploy
```

Then enable receipt scanning (optional — manual entry works without it):

```bash
npx wrangler secret put ANTHROPIC_API_KEY   # paste your key at the prompt
```

Cost control: Pro includes 30 scan attempts per calendar month, with the daily safety caps above. Set a monthly spend limit on the Anthropic workspace as an external cap. The model defaults to `claude-opus-5`; `PARSE_MODEL = "claude-haiku-4-5"` in `wrangler.toml` `[vars]` selects a cheaper model, but compare receipt accuracy before switching. The Worker emits only model, input/output token counts when available, and outcome for receipt processing; no photo, draft, receipt content or user identifier is logged. Worker log persistence remains disabled (live logs only). Prices and illustrative cost estimates are in [docs/pricing.md](docs/pricing.md); they are not measured production costs. Turnstile is half-built: the Worker verifies a `turnstileToken` whenever `TURNSTILE_SECRET` is set, but the create page renders no widget and sends no token yet — **do not set `TURNSTILE_SECRET` until that client half exists**, or every scan will fail with 403.

### Rollback

Before any customer has paid, a previous Cloudflare Worker version can be restored after confirming there are no pending Checkout sessions that could still complete. Expire open Checkout sessions and resolve any related unpaid subscriptions first, and preserve the current secrets and Durable Object data. Removing `STRIPE_PRICE_ID` from the effective Worker configuration also closes new Checkout, but the current code then disables the customer portal and returns 503 for webhook reconciliation. Use that only before customer billing exists, and remember that a later deployment can restore the price from `wrangler.toml`.

Once customers have paid, keep the Stripe product/price, API secret, webhook secret, dedicated portal and reconciliation working. Pause only the new-purchase path with a targeted change if needed; there is no separate checkout-only configuration switch today. Prefer a forward fix or a version verified to preserve paid entitlements, current billing records and cancellation access. Do not remove billing secrets, delete account data or restore an older billing implementation as a blanket rollback.
