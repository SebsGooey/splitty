# Splitty launch pricing

Effective September 10, 2026 (UTC). Sources checked on that date; prices below are USD.

## Launch offer

| | Free | Pro |
|---|---|---|
| Price | $0 | $2.99/month, recurring |
| Manual bill creation | 3/calendar month | Unlimited, subject to daily caps |
| Receipt scanning | Not included | 30 attempts/calendar month |
| Join, claim and settle through a bill link | Free, no account | Free, no account |

Only the creator needs an account or a paid plan. Allowances reset on the 1st at midnight UTC, independently of renewal dates, and do not roll over. A validated attempt counts immediately before processing, including an upstream failure or unreadable draft. Requests rejected before processing because of sign-in, validation or a daily cap do not consume a monthly scan attempt. Manual entry remains available when a Pro account uses all its scans. Admins are exempt from monthly quotas.

Daily safety caps remain: 10 scans and 30 bill creations per IP/account, and 50 scans and 300 creations across the site. These reset at midnight UTC and include qualifying failed attempts. They are separate from monthly product allowances. The global cap protects spend but can block paying customers on a busy day; monitor it before increasing acquisition.

## Why $2.99 monthly

The offer sells the host's convenience: scan a receipt and let everyone claim items through a browser link. Consumer alternatives constrain the price:

| Competitor | Primary-source evidence |
|---|---|
| Splitwise | [Pro includes scanning, itemization and unlimited expenses, with monthly and annual plans](https://kb.splitwise.com/pro/what-is-splitwise-pro). Its [US App Store listing](https://apps.apple.com/us/app/splitwise/id458023433) contains multiple Pro SKUs at $2.99, $3.99, $4.99, $29.99, $39.99 and $59.99. The listing does not label their billing intervals; no single current monthly/annual offer is established here. |
| Splid | [Official site](https://splid.app/english) advertises free use and no signup. The [US App Store listing](https://apps.apple.com/us/app/splid-split-group-bills/id991473495) lists Splid Plus at $3.99 and 2 Groups at $2.99, without an explicit duration. |
| Tricount | [Official site](https://www.tricount.com/) advertises group expense tracking as 100% free. |
| Tab | [Official US listing](https://apps.apple.com/us/app/tab-the-simple-bill-splitter/id595068606) is free and includes receipt scanning, realtime item claims and proportional tax/tip. Joining the shared bill uses its app. |

These are storefront snapshots, not logged-in checkout quotes; geography, historic SKUs and offers can change prices. The recommendation is a launch hypothesis, not evidence of willingness to pay. Measure conversion, repeat use, cancellations and receipt accuracy before raising the price.

## Illustrative economics

[Stripe US standard Payments](https://stripe.com/pricing) charges 2.9% + $0.30 for domestic cards. [Billing pay as you go](https://stripe.com/billing/pricing) adds 0.7% of Billing volume. For one $2.99 subscription collection:

`$2.99 − ($2.99 × 3.6% + $0.30) = $2.58236 after Stripe`

[Anthropic's current API pricing](https://platform.claude.com/docs/en/about-claude/pricing) lists Opus 5 at $5/million input and $25/million output tokens; Haiku 4.5 is $1 and $5 respectively. Assume 2,000 total billed input tokens, including the image and prompt, plus 800 billed output tokens per attempt:

`Opus: (2,000 × $5 + 800 × $25) / 1,000,000 = $0.03/attempt`

| Attempts in a month | AI cost | Contribution after Stripe + AI | Contribution / price |
|---|---:|---:|---:|
| 10 | $0.30 | $2.28 | 76% |
| 30 (full allowance) | $0.90 | $1.68 | 56% |
| 100 (old uncapped monthly design) | $3.00 | −$0.42 | Negative |

These are illustrative contributions, not net profit or measured production margins. They exclude hosting, support, acquisition, tax-related fees, refunds, fraud, international-card surcharges and any difference between assumed and actual token usage. A billing period can cross a calendar reset, so it can cover portions of two scan allowances. The parser permits up to 16,000 output tokens: an outlier can cost $0.40 in output alone. Review model/input/output/outcome telemetry through live logs, including failures; no receipt content or user identifier belongs in it. Log persistence remains disabled. Equal token counts on Haiku would cost $0.006, but accuracy and retry rates need evaluation before switching models.

The configured live price is 299 USD cents per month. Stripe currently has no tax registrations configured and automatic tax is off; this records settings, not a conclusion about tax obligations. See the [README launch configuration and support notes](../README.md#launch-configuration-and-support) for the product, price, dedicated customer portal and support inbox. Configuration checks do not establish that a deployment or paid customer transaction has completed.

## Why no annual, lifetime or one-off plan at launch

A monthly plan keeps the offer and entitlement handling simple while real costs and retention are unknown. A possible future $23.99 annual plan would net about $22.83 after these Stripe fees and $12.03 after 30 scans/month at the assumed cost for twelve months; it would collect less per year than monthly and commit service for longer. It is not offered at launch.

Lifetime unlimited scanning creates an ongoing cost against one payment. Individual cheap scan purchases also carry disproportionate fixed fees: a $0.99 domestic-card purchase pays about $0.33 in processing alone. A future prepaid scan pack could serve occasional users, but would require separate credit balances, redemption rules and checkout support. None are part of the launch offer.
