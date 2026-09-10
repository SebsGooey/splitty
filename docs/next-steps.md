# Splitty: next 30 days

Plan prepared September 10, 2026. The immediate goal is ten real dinner groups using Splitty, with evidence that hosts return and guests become hosts. The table is the roadmap; the implementation status below distinguishes completed work from remaining verification. These are not scheduled jobs.

Keep the current offer stable during the pilot: Free includes three manual bills per calendar month; Pro is US$2.99/month with unlimited manual bills and 30 scan attempts per calendar month. Friends join and split without an account. Ad monetization is shelved; this plan uses organic acquisition and has no advertising spend.

| When | Product and engineering work | Founder work | Evidence to collect |
|---|---|---|---|
| Days 1–3 | Put a clearly labelled sample bill above sign-in; show item claiming without an account. Add a guest-facing “Split your next bill” action after settlement. Verify the full billing lifecycle in a separate Stripe sandbox and isolated Worker environment. | Recruit the first ten people who regularly organize group meals. Arrange the first few real-meal trials. | A visitor can understand and try the core interaction before signup. Test payment grants Pro; renewal, failed payment, cancellation and expiry produce the correct access. |
| Days 4–14 | Observe the scan → review → share → claim → settle flow on iPhone Safari and Android Chrome. Fix the problems that prevent a group finishing. | Have each host use Splitty at a real meal, then ask for a second use when they next organize one. Offer optional short feedback conversations. | Who completed a split, how many people participated, where help was needed, and whether the host had another relevant occasion to use it. |
| Week 3 | Improve the most common source of friction. Make one short demonstration using a synthetic receipt and fictional names. Add a clear feedback link. | Publish the demo through Splitty's own social presence; introduce it to relevant communities where promotion is welcome. Ask satisfied hosts to introduce one other organizer. | Which introductions lead to completed group splits; whether guests start their own bills. Views are secondary. |
| Week 4 | Review usage, scan reliability and costs. Choose the next improvement from observed problems. | Invite the next ten hosts if the first cohort is completing and repeating. Ask eligible Free users whether the existing $2.99 scan offer is useful enough to purchase. | Repeat use, actual voluntary purchases and reasons for declining or stopping. |

The first implementation batch is the prominent sample demo, guest-to-host action and billing lifecycle verification. Pilot recruitment can run alongside that work.

The current demo is below the creation form (`public/index.html`), and normal settled bills lack an explicit invitation to create the next bill (`public/bill.html`). Reuse the existing demo where practical, label it as a demonstration, and keep private bill data separate. Place the guest invitation after their task so it does not interrupt claiming or payment.

The launch passed 60 integration/billing/scan checks, and live Checkout and the customer portal were opened without completing payment. Mocked billing tests cover lifecycle edge cases, but the next verification should exercise actual Stripe sandbox subscriptions, delivered webhooks and application access together. Use sandbox test clocks for renewal and cancellation timing. Keep sandbox credentials, products, webhook endpoints and Durable Object data isolated from production. [Stripe's billing test guidance](https://docs.stripe.com/billing/testing).

Track the pilot with existing operational counts and voluntary check-ins. A small private cohort sheet can record a participant-chosen identifier, signup source they volunteer, first completed group bill, second bill, guest referral and feedback. Get agreement to participate; store no receipt photos, payment handles or private bill URLs in the sheet. Do not count founder-granted access as paid conversion. If temporary Pro access is offered for usability testing, disclose its expiry and that it does not automatically charge them; evaluate paid interest separately after access ends or with a separate Free cohort.

Use these as small-sample learning targets, not industry benchmarks:

| Signal | Initial target | Decision if missed |
|---|---|---|
| First successful group split | At least 8 of 10 hosts finish with two or more participants claiming items | Fix the specific failure before bringing in more groups. |
| Repeat use | At least 4 hosts create a second real bill within 30 days | Ask whether they had another group meal; distinguish missing opportunity from choosing another method. |
| Guests becoming hosts | At least 2 guests voluntarily create their own real bill | Check whether the next-bill invitation is visible and whether guests see a reason to host. |
| Willingness to pay | First 2–3 voluntary Pro customers, excluding free grants and test purchases | Ask what is missing from the value proposition before changing price or adding plans. |

The current privacy notice promises no behavioral analytics or tracking pixels, and advance notice for material data-collection changes. Plan any new instrumentation against those commitments before implementing it. Pilot feedback and existing counts are sufficient to begin; a new analytics stack is not a dependency.

Use the founder's reported 3–5¢ per scan as the working cost range, including failed attempts when measuring real costs. At that range, 100 pilot scan attempts cost about $3–$5 in inference; 300 cost about $9–$15, excluding other expenses. There is no need to change models to start the pilot. Later, benchmark cheaper parsing against representative, consented or synthetic receipts and human-checked results; compare item/quantity accuracy, tax/tip extraction, correction effort, latency and cost per usable draft before switching.

Review the site's existing 50-scan/day global safety cap as real usage approaches it. Increase it only with an explicit spend envelope and a useful cost signal. Keep a short support routine for the Splitty Support inbox; authenticated sending from hello@splitty.cc can follow if business-Gmail replies become awkward. Confirm the business's tax-registration requirements separately before expanding sales geographically.

Defer native mobile apps, annual/lifetime plans, reward systems, broad redesigns and ad integrations until the pilot identifies a need. The next acquisition advantage should come from a useful shared bill: a host brings friends, and some friends choose to host next time.

## Days 1–3 implementation status

The prominent sample bill, guest-to-host invitation, and settlement reliability fixes are implemented. All 106 local regression checks pass, alongside desktop/mobile viewport and actual guest-flow browser checks. Real Stripe sandbox Checkout, failed-invoice handling/recovery, cancellation webhooks and entitlement boundaries were verified. Full scheduled renewal using Stripe test clocks still requires a sandbox key with test-clock access. See [verification evidence and reproduction](days-1-3-verification.md). Founder recruitment and real meal trials remain the next step.
