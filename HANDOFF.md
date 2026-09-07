# Splitty — handoff (2026-09-07)

State of play and what's next, written for whoever picks this up in Claude Code.
The README covers how the app works; this file covers **where we are and what to do**.

## Where things stand

- **Live at https://splitty.cc** (custom domain on the `splitty` Cloudflare Worker, account
  `indranet.technologies@gmail.com`). `www.splitty.cc` and
  `splitty.indranet-technologies.workers.dev` 301 to it for page loads; API/WebSocket calls
  are not redirected.
- **Deploys:** push to `main` on `github.com/SebsGooey/splitty` → Cloudflare Workers Builds
  runs `npx wrangler deploy`. Nothing else to do. Other branches get *preview* builds, which
  **fail whenever a commit adds a Durable Object migration** (previews can't run migrations)
  — harmless, merge to `main` and it deploys.
- **Shipped this week** (all on `main`, tests green):
  - Settle up: Venmo / Cash App / PayPal deep links with each person's amount, paid ticks,
    payee detection, group-chat summary.
  - Quantity-aware claims: `claims[itemId] = { personId: units }`, cost splits by units,
    unclaimed units stay unclaimed; qty field on create/edit; stepper on the bill page.
  - Accounts + tiers: `Accounts` Durable Object (SQLite). **Free = 3 bills/month, no
    scanning. Pro = unlimited + scanning ($2.99/month).** Admins (`ADMIN_EMAILS`) are Pro and
    get `/admin.html`. Stripe Checkout + signature-verified, idempotent webhook — **dormant
    until the three `STRIPE_*` values exist**; the upgrade button says "Pro — coming soon".
  - 21 integration tests in `test/integration.mjs` (run against `wrangler dev`).
- **Cloudflare variables/secrets currently set on the Worker:** `ANTHROPIC_API_KEY` (secret),
  `SESSION_SECRET` (secret), `GOOGLE_CLIENT_ID` (text, also in `wrangler.toml`),
  `ADMIN_EMAILS` (secret: `indranet.technologies@gmail.com,sebaguinot@gmail.com`),
  `CANONICAL_HOST` (text, from `wrangler.toml`). `keep_vars = true` keeps dashboard-set
  variables across deploys.
- **Google OAuth client** `572976983973-…`: authorized JavaScript origins now include
  `https://splitty.cc` and `https://www.splitty.cc` (plus workers.dev and localhost:8787).

## Do next (in order)

1. **Smoke-test the new domain as a real user.** Sign in at splitty.cc with either admin
   account → expect a `PRO` pill with "· admin" and an **admin** link. Create a bill from a
   phone, share it to a second device, claim a qty>1 line with the − / + stepper, mark paid,
   tap a Pay button with a *real* handle (the Venmo / Cash App / PayPal URL formats are the
   standard ones but were never opened against the real apps).
2. **Turn on paid Pro (Stripe).** README → "Accounts and tiers → Setup" has the exact steps.
   Short version: product + recurring $2.99/month price → `STRIPE_PRICE_ID` (text var);
   secret key → `STRIPE_SECRET_KEY` (secret); webhook endpoint
   `https://splitty.cc/api/stripe/webhook` with `checkout.session.completed`,
   `customer.subscription.created|updated|deleted` → `STRIPE_WEBHOOK_SECRET` (secret);
   enable the Customer Portal in Stripe settings. Do it in **test mode first** (test keys on
   the live site are fine — pay with `4242 4242 4242 4242`), then swap to live keys. No
   redeploy needed; the button flips as soon as all three values exist.
3. **Before charging anyone, add `/terms.html` and `/privacy.html`.** Stripe and Google's
   OAuth consent screen both want them, and the app now stores email/name per account.
   Link them from the create page footer. Privacy points to make: accounts hold Google
   `sub`, email, name, usage counters, Stripe customer/subscription ids; bills self-delete
   after 90 days; receipt images are never stored; no ads/analytics on Splitty today.
4. **Set up hello@splitty.cc** (Cloudflare → Email Routing → forward to the gmail) and use
   it as the Stripe support email / footer contact.
5. **Optional polish, roughly in value order:** PWA manifest + icons so it installs to the
   home screen; Turnstile on `/api/parse` (`TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET` are
   already wired); a real landing section above the create form for logged-out visitors;
   lightweight analytics (Armchair uses PostHog through a first-party proxy — same pattern
   would work); an "archive" of a creator's past bills (needs storing bill ids per account).

## Working on the repo

```bash
npm install
cp .dev.vars.example .dev.vars   # SESSION_SECRET, ADMIN_EMAILS, STRIPE_WEBHOOK_SECRET, dummy ANTHROPIC_API_KEY
npm run dev                      # http://127.0.0.1:8787
npm test                         # in a second terminal — 21 tests, ~2 s
npm run dev:reset                # clears local Durable Object state; restart dev after
```

- The tests create ~20 bills per run and the local `Meter` caps creates at 30/IP/day, so the
  **second full run usually 429s** — `npm run dev:reset`, restart `npm run dev`, run again.
  (Backlog: raise the cap when `env.DEV` is set.)
- The default test identity is `admin@example.com` = Pro/unlimited; tier tests mint
  non-admin identities explicitly. Sessions are minted locally with the same HMAC the Worker
  uses — no Google involved.
- Money math lives in `public/money.js` and is loaded by both `bill.html` and the tests, so
  the page and the tests always agree. Settle-up validation mirrors in `public/pay.js`.
- Data model gotchas: old bills may still hold `claims` as arrays (= 1 unit each); the DO
  normalises on load and rewrites on save — keep `claimEntries()` / `unitsOf()` when reading
  claims on the client. `bill.pay`, `bill.paid`, `bill.creatorPersonId` may be absent on old
  bills.
- `run_worker_first = true` in `wrangler.toml`: the Worker sees every request (needed for the
  canonical redirect). Static files still come from `env.ASSETS` with `_headers` applied.
- Secrets never go in the repo or in chat: set them in Cloudflare → Settings → Variables and
  Secrets. `keep_vars = true` means dashboard variables survive deploys.
- Commit style so far: imperative subject, a few "- " bullets in the body.

## Loose ends outside this repo

- **Laptop (goes back Tuesday):** `C:\Users\user\splitty` is a stale checkout with old
  uncommitted copies of files that are now on `main` — run
  `git fetch && git reset --hard origin/main` there (or clone fresh) before using it.
  Safe to delete: `C:\Users\user\hermes\_to_delete\` (a truncated 112 MB archive),
  `C:\Users\user\armchair\_to_delete\` (an empty git lock), `C:\Users\user\hermes\splitty-patches\`.
  **Keep** `C:\Users\user\hermes\armchair-nelson-2026-08-21\` (also attached in the chat):
  the never-committed Aug-21 "Nelson" audit/fix pass on Armchair — diffs, the 23 files, the
  audit report and mission notes. Decision so far: leave it alone; production runs Hermes's
  version.
- **GitHub auth:** pushes tonight used a GitHub CLI OAuth token authorised via device codes,
  stored only in the laptop's Claude session and cleared at handoff. Revoke "GitHub CLI" at
  github.com/settings/applications if you want to be tidy. From Claude Code on your own
  machine, plain `git push` with your normal credentials is all you need.
- **Armchair GG:** launch board and the Sack Race launch kit are Claude artifacts (board:
  claude.ai/code/artifact/ee632e3c-…, kit: claude.ai/code/artifact/f5878956-…). Your one
  outstanding step there: set `COMMUNITY_HASH_SECRET` on the `armchairgg` Worker to switch on
  the community-results panel. The AdSense unit is built but parked.
- **Prova (fin-forge):** pinned until the Mac mini; server backed up.
