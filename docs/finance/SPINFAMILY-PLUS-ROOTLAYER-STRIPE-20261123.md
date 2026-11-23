# SpinFamily Plus — Rootlayer billing cutover (2026-11-23)

SpinFamily is a product of **Rootlayer Software LLC**, not an independent Stripe merchant.

## Rootlayer Stripe Live catalog (verified)
- Account: `acct_1UehvfCqVYNS8CiE`.
- Product: `prod_VgMaWdEUBJEHSS` / SpinFamily Plus / hosted consumer SaaS code `txcd_10103000`.
- Monthly: **$7.00/month**, `price_1UezrsCqVYNS8CiEwjTqK2bC`.
- Annual: **$75.00/year**, `price_1UezrvCqVYNS8CiEZDg4z9c6`.
- Both products/prices are live and active. No Rootlayer live subscriptions were returned in the account-wide list on verification (2026-11-23).
- Do **not** use legacy `price_1TPmH9RrMKZPnWh6iNNzYe3T` or `price_1TPmOWRrMKZPnWh6fANoj8uT` in Rootlayer's live configuration: they are not the two approved Rootlayer catalog IDs.
- Do not modify existing subscriptions or rewrite historic amounts. Future change management must preserve grandfathered subscribers and explicit consent.

## Current application billing architecture
- Production application: https://app.spinfamilyapp.com — Netlify project `spinfamily-app`, site `a980fbdb-a438-4759-b5e5-f9ee9475f690`.
- `server/database.mjs` maps production billing price fields to `SPINFAMILY_PRODUCTION_MONTHLY_PRICE_ID` and `SPINFAMILY_PRODUCTION_ANNUAL_PRICE_ID`.
- `netlify/functions/plus-checkout.mjs` creates authenticated, household-bound Stripe Checkout subscription sessions using those values.
- `netlify/functions/stripe-webhook.mjs` verifies Stripe signatures and manages payment-gated household entitlements using idempotent storage.
- `netlify/functions/plus-portal.mjs` provides customer subscription management.
- Existing live event destination: `we_1UezshCqVYNS8CiEfeJXzH5h`, endpoint `https://app.spinfamilyapp.com/api/billing/stripe-webhook` (already enabled; do not duplicate).
- Rootlayer RICC webhook destination is **different**: `we_1UeqINCqVYNS8CiE7gDdd8nb`. It stages financial evidence, **not** household authorization.
- Production `SPINFAMILY_PRODUCTION_STRIPE_ACCOUNT_ID` already matches Rootlayer live merchant ID.
- The `STRIPE_SECRET_KEY` is sensitive and masked in Netlify connector reads; the presence of a variable is **not verification** that the underlying key is a valid Rootlayer **live** secret/restricted key. Verify scope and merchant ownership using a controlled authenticated test; do not copy key material into the repo.
- `SPINFAMILY_PRODUCTION_WEBHOOK_SECRET` exists as a masked production secret. Confirm it matches the SpinFamily event destination and verify an actual signed event.

## Changes
- Production Netlify price variable values updated (existing variable scopes preserved): `SPINFAMILY_PRODUCTION_MONTHLY_PRICE_ID=price_1UezrsCqVYNS8CiEwjTqK2bC`, `SPINFAMILY_PRODUCTION_ANNUAL_PRICE_ID=price_1UezrvCqVYNS8CiEZDg4z9c6`.
- Public application purchase button labels corrected from outdated $4.99/$49 to $7/$75.
- Added static and configuration regression test.

## Go-live tests
1. Merge PR only after tests and deploy-preview pass. Netlify production build must contain updated HTML and configuration.
2. Confirm Stripe restricted API key belongs to `acct_1UehvfCqVYNS8CiE` and is capable of customer, subscription, Checkout and Billing Portal operations; keep it secret and environment-scoped.
3. Confirm webhook destination and signing secret match, and check response health in Stripe Workbench.
4. As an authenticated synthetic household, request `GET /api/billing/status`, verify `checkoutReady=true`. Avoid accidental paid subscriptions; use sandbox for payment and entitlement tests where possible.
5. On checkout creation, verify the new price IDs and Stripe mode, customer alignment and return URLs; test successful paid subscription, failed/past-due and cancellation behavior with test card in isolated sandbox environment. Record evidence before any live customer charge.
6. Verify Plus entitlement follows signed provider events, **not** a browser success URL; no cross-household entitlement leakage.
7. QA sandbox still holds older $4.99/month / $49/year prices. Bring QA fixtures into parity in a separate sandbox change without impacting existing subscriptions.

## Notes
Production billing and the Rootlayer merchant connection are separate from Keystone's merchant onboarding. All money movement, tax assessment, finalization, refunds and payout operations stay under merchant authorization.
