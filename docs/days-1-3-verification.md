# Days 1–3 implementation and verification

## Product changes

The homepage offers a sample bill before sign-in. `/demo` uses three fictional diners and a synthetic USD receipt, with an own-item and shared-dish tutorial, exact cent totals, person switching, undo and reset. It uses the same `money.js` allocation as real bills. Its state stays in memory and it does not create bills, call an API, save names, open payment links or consume scan allowances. The exit explains host Google sign-in and Free's three manual bills per month.

A joined guest sees “Split your next bill” after their own positive claimed share is marked paid and no priced items remain unclaimed. The link goes to `/` without carrying bill IDs or tokens. Creators, payees, spectators, removed participants and zero-owed participants do not receive the invitation. Marked paid is an acknowledgement, not verification that money moved.

Review found two existing settlement defects. Financial changes could leave old paid marks in place, and overlapping asynchronous messages could overwrite newer state. Bill mutations are now ordered, meaningful allocation changes clear paid marks, and the page explains that already-sent payments need checking before paying again. Marking paid also requires the version displayed when the button was rendered; a stale acknowledgement cannot apply to a changed bill. Cosmetic edits and no-op claims retain paid marks.

## Verification layers

**106 local checks pass:** 26 integration, 17 billing, 17 scanning, 22 onboarding and 24 settlement. Production Wrangler bundling also passes.

1. Offline regression tests execute the actual demo and bill scripts; they check cent conservation, sharing, undo/reset, focus, isolated visits, and the guest-invitation visibility matrix.
2. Settlement tests cover financial edits, claims, zero-price fee allocation, participant removal, no-ops and asynchronous message ordering. Local integration tests use actual Wrangler Durable Objects and WebSockets.
3. Browser review covers keyboard interaction and desktop, 390px and 320px layouts. These are browser viewport checks; physical iPhone Safari and Android Chrome meal trials remain part of days 4–14.
4. An independent Stripe sandbox and isolated local Worker exercise real Stripe APIs and delivered, signature-verified webhooks. See the current results and reproduction steps below.

## Real Stripe sandbox results

Checked September 10, 2026, in temporary sandbox `acct_1UDxRAPRSelndiA7`, using a separate configuration and Durable Object state on local port 8790. Production Stripe resources and customers were not used.

- A browser Checkout with Stripe's published test card completed with `livemode: false`, `status: complete`, and `payment_status: paid`.
- Delivered Stripe events granted the matching local account Pro, 30 scan attempts, and the paid invoice's period end.
- A second checkout attempt returned 409 and directed the account to subscription management.
- Splitty created a session for its dedicated sandbox customer portal.
- A sandbox billing-cycle update produced a paid zero-dollar adjustment invoice and updated the paid-through date. This is an invoice reconciliation check, **not evidence of a full-price scheduled renewal**.

- A subscription update created an actual unpaid USD 2.99 invoice and `past_due` event. The paid-through date stayed unchanged. With only the local entitlement clock advanced, Pro remained available until exactly three days after that paid-through date and then scanning was disabled.
- Paying that invoice with the sandbox test card restored `active` Pro through delivered events.
- Scheduling cancellation produced the correct end date through real events. The local entitlement clock verified Pro immediately before that date and Free at the date, without grace.
- Deleting the test subscription delivered a real cancellation event and removed Pro. The temporary customer was then deleted, and the fixture clock restored to real time.

The temporary claimable sandbox key does not permit Stripe test clocks. Full scheduled renewal, failed renewal and automatic end-of-period cancellation simulation require a claimed sandbox with test-clock access. Those scheduler-driven checks are not yet recorded as completed; the event and local-clock checks above are separate evidence. The repeatable runner and local entitlement-clock fixture are provided for that verification. Its local preflight and sandbox price checks ran successfully, then Stripe returned HTTP 403 for test-clock creation; the fixture clock was reset during cleanup.

## Repeatable lifecycle test

Use Node.js 24+, Wrangler and the official Stripe CLI. Use a separate Stripe sandbox and its **test-mode** key. The runner needs access to products/prices, customers, payment methods, subscriptions, invoices and test clocks. A production application key should retain its narrower permissions.

1. Create a sandbox Pro product and USD 299-cent recurring monthly price. Do not reuse the live price from the root configuration.
2. Copy `test/fixtures/.dev.vars.example` to `test/fixtures/.dev.vars`, which is gitignored. Supply the sandbox product/price/key and two separate random local secrets. Keep these values out of logs and source control.
3. Run `stripe listen --forward-to http://127.0.0.1:8790/api/stripe/webhook` authenticated to that same sandbox. Put its signing secret in the fixture's `.dev.vars`. Forward subscription and invoice events, using the application's API version `2026-08-26.dahlia`.
4. Start the isolated Worker:

   ```bash
   npx wrangler dev --local --config test/fixtures/wrangler.stripe-sandbox.toml \
     --port 8790 --persist-to .wrangler/stripe-sandbox
   ```

5. In another terminal, run:

   ```bash
   node --env-file=test/fixtures/.dev.vars test/stripe-sandbox.mjs
   ```

6. Save the sanitized stage results, stop the listener and Worker, and remove unneeded sandbox credentials. The runner cleans up only test clocks that it creates.

The fixture is a separate entrypoint, accepts only loopback hosts and sandbox key prefixes, and requires its control secret to change the entitlement clock. Stripe test clocks do not move the application's clock; this fixture moves only entitlement evaluation alongside them. Session expiry and webhook signature freshness keep real time. The production entrypoint has no test clock or control endpoint.

The ordinary integration suite rejects non-loopback targets, redirects, enabled Stripe billing, incomplete auth and invalid local test sessions before running its mutating cases. Do not run it against the Stripe-enabled fixture.
