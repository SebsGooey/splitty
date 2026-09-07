# Splitty — handoff (2026-09-06)

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
- **Shipped earlier this week** (all on `main`, tests green): settle up (Venmo / Cash App /
  PayPal deep links, paid ticks, group-chat summary); quantity-aware claims
  (`claims[itemId] = { personId: units }`); accounts + tiers (`Accounts` Durable Object,
  **Free = 3 bills/month, no scanning; Pro = unlimited + scanning, $2.99/month**; admins in
  `ADMIN_EMAILS` are Pro and get `/admin.html`); Stripe Checkout + signature-verified,
  idempotent webhook — **dormant until the three `STRIPE_*` values exist**; the upgrade button
  says "Pro — coming soon".
- **Shipped 2026-09-06 (the "legal pages" commit):**
  - **`/terms.html` and `/privacy.html`**, receipt-styled, linked from the create-page and
    bill-page footers, under the Google sign-in button ("By signing in you agree…") and next
    to the Upgrade button ("renews monthly, cancel any time"). Written from a three-lens code
    inventory; every factual claim (cookie, tokens, localStorage keys, 90-day inactivity
    expiry, hashed-IP caps, what Anthropic/Stripe/Google receive, what admins see) was checked
    against `src/worker.js` and the pages. The operator decisions baked into the text are
    listed under "Do next" item 2 — read them once.
  - **Deletion tooling on `/admin.html`**, so the privacy policy's "email us, done within 30
    days" promise is real: per-account **Delete record** (refused until any Stripe subscription
    on it is cancelled), and a **Bills · deletion requests** section — paste a bill link, remove one
    person (their claims + paid mark go, the bill page updates live) or delete the whole bill
    (open sockets close with `expired`, so viewers see the "gone" screen). Routes:
    `POST /api/admin/accounts/delete`, `/api/admin/bills/delete`, `/api/admin/bills/remove-person`
    (admin session + same-origin, like the rest of `adminApi`).
  - **`DEV=1` in `.dev.vars`** (backlog item) multiplies the daily *create* caps ×10 locally,
    so a day of test runs no longer 429s. Never set it in production.
  - **Copy/doc fixes** found by the inventory: footer now says "90 days *of inactivity*";
    the sign-in hint no longer claims "one-time" (the cookie is 30 days); README/`wrangler.toml`
    no longer say Turnstile is "already wired" — **only the server half exists** (the create
    page renders no widget and sends no token), so setting `TURNSTILE_SECRET` today would 403
    every scan.
  - 23 integration tests in `test/integration.mjs` (run against `wrangler dev`).
- **Cloudflare variables/secrets currently set on the Worker:** `ANTHROPIC_API_KEY` (secret),
  `SESSION_SECRET` (secret), `GOOGLE_CLIENT_ID` (text, also in `wrangler.toml`),
  `ADMIN_EMAILS` (secret: `indranet.technologies@gmail.com,sebaguinot@gmail.com`),
  `CANONICAL_HOST` (text, from `wrangler.toml`). `keep_vars = true` keeps dashboard-set
  variables across deploys.
- **Google OAuth client** `572976983973-…`: authorized JavaScript origins include
  `https://splitty.cc` and `https://www.splitty.cc` (plus workers.dev and localhost:8787).

## Do next (in order)

1. **Set up hello@splitty.cc first** (Cloudflare → Email Routing → forward to the gmail).
   Both legal pages name it as the only contact and the deletion-request channel; until it
   forwards, mail bounces. Use it as the Stripe support email too.
2. **Read `/terms.html` and `/privacy.html` once as the operator** and confirm the decisions
   embedded in them (each is a one-line edit if you want something else):
   - operator named as **Indranet Technologies**; **no postal address** is published
     ("available on request") — add one if you have it; California/EU consumer rules expect
     one before you sell;
   - **governing law is worded neutrally** ("the place where Indranet Technologies is
     established") — name a state/country if you prefer;
   - **liability cap**: the greater of 12 months' fees or US$20; **refunds**: none except where
     the law requires, plus a pro-rated refund for EEA/UK 14-day withdrawals and a refund if we
     withdraw Pro mid-period; **ages**: 13+ to use, 18+ to buy Pro;
   - **promises that are manual work**: deletion within 30 days (the admin page makes it a
     click), a reply to rights requests within a month, and **30 days' email notice** before a
     price or terms change (there is no email-sending code — you'd mail the addresses listed on
     `/admin.html` from hello@).
   Have a lawyer look before Pro goes on sale.
3. **Smoke-test the new domain as a real user.** Sign in at splitty.cc with either admin
   account → expect a `PRO` pill with "· admin" and an **admin** link. Create a bill from a
   phone, share it to a second device, claim a qty>1 line with the − / + stepper, mark paid,
   tap a Pay button with a *real* handle (the Venmo / Cash App / PayPal URL formats are the
   standard ones but were never opened against the real apps). Open the footer links, and try
   the admin page's **Bills · deletion requests** on a throwaway bill.
4. **Turn on paid Pro (Stripe).** README → "Accounts and tiers → Setup" has the exact steps.
   Short version: product + recurring $2.99/month price → `STRIPE_PRICE_ID` (text var);
   secret key → `STRIPE_SECRET_KEY` (secret); webhook endpoint
   `https://splitty.cc/api/stripe/webhook` with `checkout.session.completed`,
   `customer.subscription.created|updated|deleted` → `STRIPE_WEBHOOK_SECRET` (secret).
   Also in Stripe: enable the Customer Portal and set it to **cancel at the end of the billing
   period** (the terms say Pro stays on until the paid period ends); paste the terms + privacy
   URLs into Settings → Business → Public details; switch on customer receipt emails. Do it in
   **test mode first** (test keys on the live site are fine — pay with `4242 4242 4242 4242`),
   then swap to live keys. No redeploy needed; the button flips as soon as all three values
   exist. Optional hardening once the Stripe ToS URL is set: add
   `form["consent_collection[terms_of_service]"] = "required"` in `billingCheckout` so
   Checkout shows an "I agree to the terms" checkbox.
5. **Google OAuth consent screen:** add the privacy-policy and terms URLs (Cloud console →
   APIs & Services → OAuth consent screen). The privacy page carries Google's Limited Use
   disclosure in the prescribed form.
6. **Optional polish, roughly in value order:** self-serve "delete my account" (needs a Stripe
   cancel-subscription call first — the admin route refuses until the subscription is cancelled);
   the Turnstile *client* half (widget + `turnstileToken` in the scan request +
   `challenges.cloudflare.com` in the CSP) before ever setting `TURNSTILE_SECRET`; PWA manifest
   + icons; a landing section above the create form for logged-out visitors; lightweight
   analytics (Armchair uses PostHog through a first-party proxy — **update privacy.html §8 and
   §17 first**, it currently promises none); an "archive" of a creator's past bills (needs
   storing bill ids per account — also a privacy-page change, bills are currently unlinked).

## Working on the repo

```bash
npm install
cp .dev.vars.example .dev.vars   # SESSION_SECRET, ADMIN_EMAILS, STRIPE_WEBHOOK_SECRET, dummy ANTHROPIC_API_KEY, DEV=1
npm run dev                      # http://127.0.0.1:8787
npm test                         # in a second terminal — 23 tests, ~3 s
npm run dev:reset                # clears local Durable Object state; restart dev after
```

- `DEV=1` raises the local create caps to 300/IP/day; `npm run dev:reset` is still the escape
  hatch. Wrangler only reads `.dev.vars` at start — restart `npm run dev` after editing it.
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
- **Windows checkouts:** git's autocrlf rewrites touched files as CRLF, so anchor-based edit
  scripts must match the file's own line endings. The desktop app's Browser pane starts the
  dev server from `.claude/launch.json` (gitignored).
- Commit style so far: imperative subject, a few "- " bullets in the body.
- If a feature changes what the app stores or who sees it, **update `/privacy.html` in the
  same commit** (and bump its effective date); the terms page mirrors a few of those facts
  (creator powers, 90-day rule, deletion) — keep them in step. The `legal pages` test only
  checks the pages exist and link correctly, not their content.

## Loose ends outside this repo

- **Laptop (goes back Tuesday 2026-09-08):** `C:\Users\user\splitty` is now synced to
  `origin/main`; its old uncommitted edits are parked in `git stash` ("stale laptop working
  tree before sync 2026-09-06") — `git stash drop` when convenient. The copies of
  `HANDOFF.md` and the `0001-HANDOFF…patch` in `Downloads` are superseded by this file.
  Safe to delete: `C:\Users\user\hermes\_to_delete\` (a truncated 112 MB archive),
  `C:\Users\user\armchair\_to_delete\` (an empty git lock), `C:\Users\user\hermes\splitty-patches\`.
  **Keep** `C:\Users\user\hermes\armchair-nelson-2026-08-21\`: the never-committed Aug-21
  "Nelson" audit/fix pass on Armchair — diffs, the 23 files, the audit report and mission
  notes. Decision so far: leave it alone; production runs Hermes's version.
- **GitHub auth:** earlier pushes used a GitHub CLI OAuth token authorised via device codes,
  stored only in the laptop's Claude session and cleared at handoff. Revoke "GitHub CLI" at
  github.com/settings/applications if you want to be tidy. From Claude Code on your own
  machine, plain `git push` with your normal credentials is all you need.
- **Armchair GG:** launch board and the Sack Race launch kit are Claude artifacts (board:
  claude.ai/code/artifact/ee632e3c-…, kit: claude.ai/code/artifact/f5878956-…). Your one
  outstanding step there: set `COMMUNITY_HASH_SECRET` on the `armchairgg` Worker to switch on
  the community-results panel. The AdSense unit is built but parked.
- **Prova (fin-forge):** pinned until the Mac mini; server backed up.
