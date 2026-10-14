# SpinFamily — Historical live Stripe audit

**Record date:** 2026-10-14. **Scope:** read-only reconciliation of historical SpinFamily payment processing; **production billing changes:** none. This is canonical engineering evidence, not a production activation approval.

## Merchant account identity

- Original Stripe merchant, now re-authorized and verified: **Chasing Dreams Development Team**, Stripe account `acct_1QeSzoRrMKZPnWh6` (live mode).
- Separately connected CDDT account `acct_1UMjQ43rtEuckVRr` is **not** the holder of SpinFamily's original live links/prices; keep their secrets and billing states separate.
- Separate test-mode account `acct_1UPvTsRxMvndUgno` is SpinFamily QA only.

## Verified live SpinFamily assets

| Item | Existing ID | Price | Status |
| --- | --- | --- | --- |
| Product | `prod_UOZPq0BirfAd6k` | SpinFamily Plus | Existing |
| Monthly | `price_1TPmH9RrMKZPnWh6iNNzYe3T` | USD $4.99/month | Existing |
| Annual | `price_1TPmOWRrMKZPnWh6fANoj8uT` | USD $49/year | Existing |
| Monthly Payment Link | `plink_1TPmXtRrMKZPnWh6jxSkHQsR` | Monthly | Active |
| Annual Payment Link | `plink_1TPmZXRrMKZPnWh6kDy8tV2a` | Annual | Active |

Monthly URL: https://buy.stripe.com/28E28tgIs0Kz7hYajZ6EU00

Annual URL: https://buy.stripe.com/bJe8wRgIs1OD9q677N6EU01

**Release defect:** Both links currently redirect completed checkout to
`https://posh-ib.github.io/spinFamily/html?plan=monthly&session_id={CHECKOUT_SESSION_ID}`.
The annual link also incorrectly specifies `plan=monthly`. This is a historical client redirect and cannot establish authenticated household entitlement. Never use this success URL as payment proof. Do not alter these live links until new origin and backend verification are tested.

## Historical attempted transaction

- Stripe Checkout Session: `cs_live_a1ol0w3Q9epec4eaijuRAECqwVPUrKyiKEz7kiNXesSkbTkSkXTpUhfYQN`.
- Created **2026-04-24 18:28 UTC** (2:28 PM Eastern).
- Linked to the **monthly SpinFamily Payment Link**, amount **$4.99**.
- **Session status:** `expired`; **payment status:** `unpaid`.
- **No PaymentIntent**, customer, or subscription ID attached to the session.
- Session expiry: 2026-04-25 18:28 UTC.
- Live annual link: **zero sessions** at time of this audit.
- Subscriptions filtered for *both* SpinFamily price IDs: **zero**; each query returned `has_more=false`.

## Other live activity — do not conflate with SpinFamily

- The original CDDT merchant also showed **four successful PaymentIntents and four successful charges** on other dates/amounts, and **two Checkout Sessions in total** (the SpinFamily expired checkout plus a separate expired one-time session).
- No listed successful Checkout Session or subscription was associated with either SpinFamily Payment Link.
- **Do not conclude the other charges are SpinFamily purchases by coincidental amount or email**. Do not import or expose customer personal data from unrelated products.

## Existing webhook separation

- Merchant webhook endpoint `we_1UPqVLRrMKZPnWh6ndwMb7fo`: `https://relayercre.com/.netlify/functions/stripe-webhook`, enabled.
- **This is ReLayer's webhook, not SpinFamily's**. Do not update it, re-use its signing secret, or route SpinFamily events through it.
- A dedicated SpinFamily webhook and per-environment secret are needed after its verified endpoint is reachable. Existing product/price IDs should be re-used; don't create duplicate *live* Stripe assets.

## Release gate

1. Verify Netlify-hosted preview DB and applied migrations; confirm Identity and secure household session on deployed preview.
2. Verify Stripe QA checkout/webhook and premium activation/revocation with its sandbox product and secrets; validate replay/order and tenant isolation.
3. Securely link Stripe customer/subscription to signed-in household using server-issued session correlation; no email-only or return-URL trust.
4. Before *live* launch, use existing **original merchant** and production prices, a **dedicated SpinFamily production webhook**, and proper production-only secret configuration.
5. Change live Payment Link completion redirects **only after** the correct domain app handles authenticated, server-verified checkout sessions; fix annual plan parameter. If static links cannot securely correlate household identity, steer authenticated customers through server-created Checkout instead and keep old links out of the launch flow until a safe claim process exists.
6. Confirm app plan UI pricing, subscription portal configuration, database budget and production release safety.
7. Obtain provider evidence for successful domain attachment, DNS, SSL, checkout lifecycle before marking released.

**Rootlayer canonical record:** GitHub audit here + Rootlayer Software Notion SpinFamily engineering page.
