# SpinFamily release gate — October 14, 2026

Status: **BLOCKED — CI build and database tests passed, end-to-end service activation unverified.**

## Verified engineering state
- Draft PR #5 visual direction remains unmerged, with original wheel and artwork preserved.
- Draft PR #7 adds account sign-in, household custom-activity persistence, modern Netlify Functions, billing checkout/portal, signature-verified subscription webhook, additive schema migrations, and static bundle.
- The CI test suite ran successfully on the combined branch before the latest styling edit. Use subsequent head SHA status for final qualification.
- PostgreSQL migrations applied in ephemeral CI Postgres; **not verified on Netlify hosted DB**.
- Stripe QA account acct_1UPvTsRxMvndUgno has product prod_VRPDwrBKstwyBF and test prices:
  monthly price_1UQWOzRxMvndUgnoD891aKNS ($4.99);
  annual price_1UQWPhRxMvndUgnoFEif49Ps ($49).
- Both QA prices are populated in Netlify deploy-preview Functions variables.
- Existing live Stripe product and payment links are untouched.

## External release blockers
1. In Netlify project spinfamily-app verify that PR #7 has a functioning Deploy Preview and isolated DB branch; inspect build and function logs and applied migrations.
2. Verify Identity signup, confirmation, login/logout, and session verification on an actual preview.
3. Set preview Functions-only secret variables STRIPE_SECRET_KEY (test key) and STRIPE_WEBHOOK_SECRET (QA endpoint signing secret) and SPINFAMILY_CHECKOUT_ORIGIN (actual HTTPS preview origin). Never paste credentials into GitHub or Notion.
4. Register Stripe test webhook at reachable preview endpoint /api/billing/stripe-webhook for checkout.session.completed and customer.subscription created/updated/deleted.
5. Complete two test checkouts, activation, reload/login persistence, cross-household isolation, cancellation, expiration, failed-payment revocation, event replay/out-of-order tests.
6. Resolve concurrency guards for duplicate checkout and the twenty-activity cap and compare subscription status against Stripe before releasing live payment.
7. Confirm Netlify Database cost, branch retention, and sleep-on-idle and budget monitoring.
8. After verified preview: provision production-only Stripe secrets and webhook; approve production billing gate, merge staged PRs, smoke-test production, attach spinfamilyapp.com in Netlify dashboard, update registrar DNS, confirm HTTPS certificate and Identity redirect domain.

## Connector limits
Connected Netlify tool can manage env vars, but cannot attach a custom domain, change DNS, provision/inspect hosted DB branches, execute migrations, or read site deploy logs. Do not claim an external milestone is complete without provider evidence.

## Canonical references
- https://github.com/Posh-IB/spinFamily/pull/7
- https://github.com/Posh-IB/spinFamily/actions
- https://app.notion.com/p/3f75dd5a1079817f8b29e87760e6435e

## 2026-10-14 historical Stripe reconciliation correction
- Founder confirmed an attempted SpinFamily transaction months earlier, before the app refresh. This is a **reported payment attempt**, not a Stripe-verified charge or subscription.
- Existing **live** Stripe Payment Links were already embedded in earlier public repository files `spinfamily_with_upgrade.html` and `spinfamily_with_backend_auth.html`: monthly https://buy.stripe.com/28E28tgIs0Kz7hYajZ6EU00 and annual https://buy.stripe.com/bJe8wRgIs1OD9q677N6EU01. Do NOT replace, invalidate, or duplicate these live links without separate product-owner authorization.
- The old `spinfamily_with_backend_auth.html` stored Stripe Price IDs and publishable key as literal **placeholders**, with backend URL empty unless a user populated localStorage. On missing backend or verification failure, legacy `simulatePremiumActivation` generated mock active subscription state in browser localStorage. Hence the legacy success screen cannot prove a real payment or secure entitlement.
- Original checkout link buttons were actual Stripe-hosted links, which can process an attempted transaction without SpinFamily Netlify environment keys. A Stripe transaction, if it occurred, would exist on the original connected Stripe merchant account, not necessarily in current web app database.
- The Netlify `spinfamily-app` site currently has only the two **new preview QA price variables**, no STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET at site scope; the root team has no shared environment variables. This site dates from the later Netlify migration. The Netlify `frameworkos-rootlayer-preview` site does have both Stripe secret keys, but they are **FrameworkOS configuration**, not evidence of SpinFamily server entitlement deployment. Never copy cross-product secrets or webhook signatures.
- Prior observed Stripe merchant: Chasing Dreams Development Team (`acct_1QeSzoRrMKZPnWh6`, live). Current Stripe session advertises only separate SpinFamily QA sandbox (`acct_1UPvTsRxMvndUgno`), so direct charge/checkout/subscription reconciliation on original live merchant is temporarily **access-blocked** pending user account reconnection; do not claim there were no prior transaction attempts.
- Verification task after reconnect: search original merchant's charges, payment intents, Checkout Sessions, Payment Links and subscriptions tied to SpinFamily links and dates; distinguish attempted, failed, test and settled transactions; reconcile any actual subscriber before replacing the checkout path.

## 2026-10-14 — Live Stripe reconnection audit (merchant identity mismatch)
- User reauthorized a live Chasing Dreams Development Team Stripe account.
- Currently visible live CDDT account ID: acct_1UMjQ43rtEuckVRr. **This is not the historical SpinFamily owner** acct_1QeSzoRrMKZPnWh6 that previously returned SpinFamily Plus product and two active Payment Links.
- Query of the newly visible account returned 0 payment links, 0 checkout sessions, 0 charges, 0 subscriptions and 0 webhooks; 1 unrelated PaymentIntent (no successful charge, requires_payment_method).
- Direct retrieval on the newly authorized CDDT account of the two historical SpinFamily Payment Link IDs and two historical Price IDs returned `No such payment link` and `No such price`. They belong to another Stripe account context.
- Do **not** assume there is no earlier SpinFamily payment attempt. Its provider records must be queried from the historical merchant account ID. Do **not** copy Stripe credentials from another Rootlayer product, create duplicate live products, or switch SpinFamily live billing to the newly authorized account.
- Blocker: obtain and authorize the exact historical Stripe account acct_1QeSzoRrMKZPnWh6, then inspect payment-link-derived Checkout Sessions (including expired/incomplete), PaymentIntents, charges, and subscriptions before live release.
- Stripe QA sandbox remains separately connected; this audit made no mutations to either live merchant account.

## October 14 final pre-deadline hardening
- The founder requested finishing without real-money pay/refund testing. No real-money payment has been attempted; synthetic Stripe signature/entitlement and Postgres isolation CI remain the test strategy.
- Same-origin validation added to authenticated Plus mutations, checkout, and portal functions, preserving guest wheel access.
- Netlify Database webhook updated to obtain a PostgreSQL connection from `getConnectionString()` rather than assuming an undocumented `db.pool` interface; `pg` is now runtime dependency.
- The current published Netlify production deploy (September prototype, commit `dd3be2b`) has **zero functions deployed** and no database branch ID. GitHub Actions passing on draft PR #7 does not mean Netlify deploys PR #7.
- No connected Netlify action can directly trigger deploy, set custom domain or DNS, or inspect hosted database migrations. Domain and Plus activation still require browser-based Netlify deployment and identity verification, separate Stripe signing key configuration, and service evidence. Never mark billing launch complete solely from unit tests.
- Release safety option: ship free guest SpinFamily experience independently if necessary, keep paid UI disabled until server-side verification is functional; do not present paywall as purchasable and usable before entitlement proof.
