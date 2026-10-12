# SpinFamily — Identity, Household Data & Subscriptions v0.1

Status: implementation branch, not released. Parent: PR #5 presentation candidate.

## Decisions
- Guest mode stays anonymous, functional and free. Login never blocks spinning. Custom activity creation, durable saved activities, behavior history and personalization are Plus-only capabilities.
- Netlify Identity is the authentication provider; server endpoints verify identity, not browser-provided user IDs.
- Netlify Database (managed PostgreSQL) is the persistence target, subject to confirming project eligibility and cost controls.
- Billing provider CONFIRMED: existing Stripe live-mode SpinFamily Plus product and two hosted recurring Payment Links. Reuse; do not recreate. Billing Portal and entitlement sync are separate unverified integrations.
- Household subscription entitlement is server-owned and derives only from verified billing webhook events, never client input.
- Children are not account holders. Minimize data: aliases and optional preferences only; avoid birthdates, school, location, sensitive notes.
- Preview deployments must not expose production household data. Verify Netlify Database branch seeding behavior before provisioning or inserting PII.
- Keep all account and billing features disabled in the public UI until authentication, isolation and webhook tests pass.

## Core entities
1. account_profiles: one row per verified Netlify Identity subject.
2. households: owner-bound household.
3. household_members: display aliases; not user accounts.
4. saved_plans: per-household plan JSON with server timestamps.
5. subscriptions: one per household, with provider IDs and status.
6. billing_events: idempotent webhook processing and audit.

## Required server routes
- GET /api/me — verified identity and household entitlement.
- GET/POST /api/household — owner-scoped household and aliases.
- GET/POST /api/plans — Plus-only owner-scoped saved plans; validate payload size.
- GET/POST /api/activity-events — Plus-only server-validated events: selected, completed, skipped, swapped. Use bounded event history to calculate repeat avoidance and weekly variety; never let event history determine authorization.
- POST /api/billing/checkout — authenticated owner; allowlisted Stripe price ID; server-created session.
- POST /api/billing/portal — authenticated owner; existing Stripe customer only.
- POST /api/billing/webhook — verify raw Stripe signature, transactionally deduplicate event ID, update subscription state.

## Security and acceptance
- 401 on missing/invalid token; 403 on cross-household requests; no household IDs trusted from browser.
- Server determines household from authenticated subject on every request.
- No client-writeable premium flags, no secret keys in HTML or JS bundles.
- No paid access granted from Checkout redirect or unverified webhook. Existing hosted payment links must be associated with a verified signed-in subject using a tamper-resistant server-issued claim reference, confirmed against Stripe checkout/subscription objects and webhook records. Email-only matching is insufficient.
- Handle canceled, unpaid, past_due and trialing states explicitly.
- Add tests for cross-account isolation, webhook replay/out-of-order events, subscription cancellation, anonymous continuity and plan persistence.
- Define deletion/export and retention before real household data is collected.
- Enforce preview/staging separation, rate limits, structured redacted logs and rollback.

## Implementation gates
G0: verify Identity configuration, Netlify plan eligibility, database billing limits, and existing Stripe live-mode configuration; keep live billing isolated from preview tests.
G1: add migration + backend endpoints; local and preview tests with synthetic data only.
G2: add opt-in login and household save UI behind feature flag; anonymous regression.
G3: reconcile existing hosted Stripe payment links with verified webhook and authenticated household entitlements in a safe test environment; do not replace links or create live products.
G4: founder review of privacy, pricing, retention, costs and test evidence.
G5: separate explicit production activation approval. No production activation is authorized here.

## Verified Stripe inventory (2026-10-11)
- Account: Chasing Dreams Development Team, `acct_1QeSzoRrMKZPnWh6` (live mode).
- Product: SpinFamily Plus, `prod_UOZPq0BirfAd6k`.
- Monthly $4.99: `price_1TPmH9RrMKZPnWh6iNNzYe3T`, existing link https://buy.stripe.com/28E28tgIs0Kz7hYajZ6EU00.
- Annual $49: `price_1TPmOWRrMKZPnWh6fANoj8uT`, existing link https://buy.stripe.com/bJe8wRgIs1OD9q677N6EU01.
- Both hosted payment links are active, recurring, and live. Do not change them.
- Production `main` HTML has no visible Stripe billing code and repository tree contains no Stripe backend files; entitlement synchronization remains unverified.

## Founder-approved Plus entitlement policy
- Free: anonymous wheel, curated activity browsing and ephemeral plans. No forced signup.
- Plus: custom activity creation; persistent custom activities and plans across refresh/logout; activity history; detection of repeated choices and swaps; anti-monotony suggestions and week-level tailoring.
- Plus status is a feature entitlement only; it conveys no backend, admin, database, dashboard or API management access.
- Browser cannot be trusted to claim entitlement, ownership, event history or Stripe customer IDs. Server must verify signed-in subject, ownership and active subscription on each premium request.
- Guest session data is ephemeral. After Plus activation, opt-in migration can move user-entered custom activities into the authenticated household; never automatically upload participant data.
- Personalization v0.1 uses explainable deterministic rules: recent-use penalty, swap/skip penalty, category variety and caregiver override. No external AI model, child profiling or opaque cognitive scoring.
- Privacy: event logs record activity IDs, timestamps, action and household reference; avoid free-text child profiles and sensitive inferences. Offer history deletion and configurable retention.
- Existing Stripe links remain untouched. Subscription linkage needs verified Checkout Session / subscription ownership and a securely issued household correlation reference; success URL alone cannot activate Plus.
