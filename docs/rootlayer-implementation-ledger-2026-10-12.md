# Rootlayer / SpinFamily implementation ledger — 2026-10-12
Classification: engineering evidence / draft; not ratified production capability.
Project: SpinFamily, Rootlayer Software. Public repo: Posh-IB/spinFamily.
Branch: work/identity-subscriptions-2026-10-11. Visual milestone PR #5 protected.
Private core: Posh-IB/spinFamily-core; do not copy private planning algorithms into public repo.

## Record
- Founder requested authenticated household → verified Stripe Plus entitlement → moderated custom activity persistence, preserving existing Stripe links.
- Founder requires work to be reconciled into appropriate canonical Rootlayer locations.
- Verified existing Stripe Plus product and monthly/annual links in live account; no Stripe changes made.
- Prepared proposed SQL under docs/ (not executed).
- Added content moderation library and regression fixtures.
- Added isolated household authorization boundary and fail-closed Netlify Function adapter.
- Netlify Function currently returns service_unavailable for authenticated users because real persistence and verified billing adapters are not wired. No claim of functional saved activities.
- No Netlify Identity setup verification, Netlify Database provisioning, Stripe webhook verification or end-to-end tests completed.
- Privacy: no child profiling; no rejected content persistence; browser input cannot select household/entitlement.
- Required follow-on: inspect Netlify Identity verification semantics and secure runtime, configure database migrations in isolated environment, implement Stripe subscription linkage/webhook, wire adapters, test tenant isolation and rollback.
- Canonical publication targets: this GitHub ledger + relevant Rootlayer Notion registry / architecture / project implementation records. Do not mark external records updated until confirmed.
- Release gate: founder approval required for production merge, live billing modification, database changes or public feature activation.

## 2026-10-13 — Preview-only billing implementation / founder work order
- Draft PR #7: https://github.com/Posh-IB/spinFamily/pull/7 (base `work/identity-subscriptions-2026-10-11`; neither PR #5 nor main modified).
- Stripe Plus existing live prices retained. Stripe account query returned zero current subscriptions on either SpinFamily Plus price; no historical account linkage needed as of this read.
- Existing SQL migration `20261012210700_spinfamily_plus.sql` remains authoritative and was NOT edited; incompatible duplicate migration withdrawn. Additive migration `20261013162900_plus_checkout_linkage.sql` extends its schema.
- New modern Netlify server functions authenticate via `@netlify/identity`, access `@netlify/database`, create securely linked Stripe Checkout Sessions and billing portal sessions, and verify raw-body Stripe webhooks with SDK.
- Webhook idempotency uses `stripe_processed_events`, an existing schema object; do not introduce parallel payment event sources.
- Preview billing configuration is fail-closed without Stripe test-mode key, separate signing secret, test-mode monthly and annual price IDs and explicit HTTPS return origin.
- Billing lifecycle tests are not equivalent to real Stripe sandbox integration. PostgreSQL integration CI runs separately; local schema files are not proof of Netlify provisioning or remote migration application.
- Rootlayer Software Notion page https://app.notion.com/p/3f75dd5a1079817f8b29e87760e6435e records this scope and gate.
- FinOps: confirm credit-based Netlify plan, branch auto-sleep, active compute/egress costs, DB branch before approving any persistent preview and do not accrue costs from idle apps.
- Release remains blocked until Netlify preview isolation, signed test webhook, full checkout → active → canceled/expired/failed-payment → revoked entitlement, multi-tenant isolation, and CI are actually verified.
