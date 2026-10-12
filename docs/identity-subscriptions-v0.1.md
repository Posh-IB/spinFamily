# SpinFamily — Identity, Household Data & Subscriptions v0.1

Status: implementation branch, not released. Parent: PR #5 presentation candidate.

## Decisions
- Guest mode stays anonymous, functional and free. Login never blocks spinning.
- Netlify Identity is the authentication provider; server endpoints verify identity, not browser-provided user IDs.
- Netlify Database (managed PostgreSQL) is the persistence target, subject to confirming project eligibility and cost controls.
- Billing provider proposed: Stripe Checkout + Billing Portal; no payment provider is activated by this branch.
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
- GET/POST /api/plans — owner-scoped saved plans; validate payload size.
- POST /api/billing/checkout — authenticated owner; allowlisted Stripe price ID; server-created session.
- POST /api/billing/portal — authenticated owner; existing Stripe customer only.
- POST /api/billing/webhook — verify raw Stripe signature, transactionally deduplicate event ID, update subscription state.

## Security and acceptance
- 401 on missing/invalid token; 403 on cross-household requests; no household IDs trusted from browser.
- Server determines household from authenticated subject on every request.
- No client-writeable premium flags, no secret keys in HTML or JS bundles.
- No paid access granted from Checkout redirect or unverified webhook.
- Handle canceled, unpaid, past_due and trialing states explicitly.
- Add tests for cross-account isolation, webhook replay/out-of-order events, subscription cancellation, anonymous continuity and plan persistence.
- Define deletion/export and retention before real household data is collected.
- Enforce preview/staging separation, rate limits, structured redacted logs and rollback.

## Implementation gates
G0: verify Identity configuration, Netlify plan eligibility, database billing limits and Stripe account/test mode.
G1: add migration + backend endpoints; local and preview tests with synthetic data only.
G2: add opt-in login and household save UI behind feature flag; anonymous regression.
G3: add Stripe test-mode checkout/portal and verified webhook; negative-path tests.
G4: founder review of privacy, pricing, retention, costs and test evidence.
G5: separate explicit production activation approval. No production activation is authorized here.
