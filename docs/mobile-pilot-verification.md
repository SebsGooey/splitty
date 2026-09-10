# Mobile reliability and pilot preparation

Verified September 10, 2026. This release changes the create page, bill page, shared mobile styles, local regression tests and documentation. It does not change Worker logic, pricing, secrets, account entitlements or stored bill data.

## Result

- Temporary network failures no longer render a bill as deleted. Reconnects check actual HTTP status, wait for a fresh WebSocket snapshot and detect stalled connections. Mobile resume and restored pages reconnect.
- Unsent bill corrections remain in the editor during a disconnect. Mutations are not automatically replayed. Payment links on the current page lose their destinations while disconnected; a fresh snapshot restores the current amounts.
- Repeated Join taps are guarded. A lost acknowledgement prompts the user to check existing names instead of guessing identity or replaying the join. Blocked browser storage no longer prevents opening a bill or using a creator backup link.
- Create stays guarded through quota refreshes. Returning with the browser Back button restores the editor after a completed creation.
- Scans can be cancelled and time out after 90 seconds. A slow quota refresh no longer traps the form. A submitted attempt may still count after cancellation; the page says so and never automatically retries a scan.
- Scans preserve corrections made while processing; replacing those corrections requires the explicit apply button. A receipt without a tip clears the previous receipt's tip. Late results and stale account refreshes cannot overwrite a newer scan or restore a signed-out account.
- Photo preparation releases decoded bitmaps, flattens transparent images onto white and supports a local image-element fallback. Invalid quantities and amounts on the create page receive correction guidance.
- Narrow screens have wider item names, 44px primary editing/settlement controls, 16px editable text, stacked payment fields and wrapped long names without splitting currency amounts across lines.

## Automated checks

All 154 checks passed on Node.js 24. The integration suite ran against the isolated local Wrangler server with billing disabled. Other suites use offline fakes; no production bills or paid scan requests were created by these regressions.

| Suite | Passed | Coverage |
|---|---:|---|
| Integration | 26 | Real local Worker, Durable Objects, WebSockets, API/auth gates and assets |
| Billing | 17 | Mocked Stripe reconciliation, entitlements, concurrency and retries |
| Scans | 17 | Mocked provider processing, quotas, failure accounting and privacy |
| Onboarding | 22 | Fictional demo, guest invitation and settlement version behavior |
| Settlement | 24 | Paid-state invalidation, concurrent mutations and bill expiry |
| Connections | 24 | Reconnects, timeouts, offline edits, payment destinations, Join and storage |
| Receipt input | 24 | Cancellation, decoding, correction races, account refreshes and create recovery |

The connection and receipt suites execute the actual inline page scripts using the shared DOM harness and deterministic network/timer fakes. They do not substitute for a browser layout or physical-device test. Run them with `npm run test:connections` and `npm run test:receipt-input`; see the README for the other commands.

## Browser checks

Local browser checks used synthetic receipts and guests:

- Created a bill with a $12.50 line total, quantity two, $1.25 tax and 20% tip; preview and created bill both showed $16.25. A fractional quantity was rejected before submission, with focus on the field.
- Joined as a guest, claimed an item and reopened the link; the saved identity and claim were restored.
- Simulated a connection drop, attempted a paid acknowledgement, then restored connectivity. The page displayed an offline error, reconnected and did not replay the acknowledgement.
- Entered a creator correction, tried saving offline, then reconnected. The unsent correction remained in the editor and saved successfully after an explicit retry. Reopening Edit focused its labelled first field.
- Checked create, edit and a long-name/shared-item stress bill at 320px and 390px viewports. At 320px the stress bill previously scrolled to 568px despite having only 305px of available width; after the fix its scroll width matched 305px. At 390px it matched the 375px available width.

Independent reviews of the receipt and connection changes found and resolved two additional regressions before release: same-account refreshes invalidating a newer scan, and native open-link actions bypassing a click-only offline payment guard. Both have focused regression coverage.

## Remaining limits and next action

- Physical iPhone Safari and Android Chrome camera input, HEIC handling, lock/sleep behavior and payment-app return still need real-device trials. Synthetic decoder tests and desktop viewport checks do not verify those capabilities.
- Create prevents concurrent submissions. If the server creates a bill but its response is lost, a later retry can still create another bill. Server-side idempotency is the follow-up needed to resolve this ambiguity.
- A Join whose acknowledgement is lost can leave a participant without a recoverable token. The page explains the situation; the creator may need to remove a duplicate. It does not adopt another participant's identity.
- Disabling current-page payment links cannot revoke links already copied elsewhere or native menus already opened. Paid marks remain acknowledgements rather than verified transfers.
- Full scheduled Stripe renewal remains unverified pending a sandbox key with test-clock access. Prior real sandbox payment/failure/cancellation evidence is recorded separately in the days 1–3 notes.

Use the [first-three-host pilot kit](pilot-kit.md). Invite three organizers to use Splitty at actual meals, fix any issue that prevents completion, then expand toward ten. Invitations are drafts only; no outreach or participant recruitment has been performed.

## Release checks and recovery

Before release: all checks above pass, independent review is complete, and `git diff --check` is clean. Build the production entry point with `wrangler deploy --dry-run`; deploy through the existing main-branch Cloudflare build. Verify the build's exact commit, compare the served HTML/CSS to the repository, and check the public billing/auth gates and absence of sandbox control routes.

If the release prevents bill creation, claiming or reconnection, restore the immediately preceding verified frontend or make a targeted forward fix. Keep the current Worker billing logic, secrets and Durable Object data intact. This release has no database migration.
