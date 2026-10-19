# SpinFamily QA Database Boundary — verification hold (2026-10-19)

**Status:** HOLD. This file is a release-gate evidence record, not evidence of a pass.
**Scope:** QA-only PR #14 (`codex/hosted-auth-qa-2026-10-16`), never merge. This commit changes documentation only; production/main, billing, and database data are unchanged.

## Reason for controlled rebuild
- Netlify Deploy Preview #14 `6ad2e17acac665ae5d030e5c` is ready at source SHA `cd4c2920ddfbbfe75eb791d022af4662c7acf7c3`, but its deployment metadata reports `database_branch_id: null`.
- Netlify Deploy Preview #12 `6ad2aa06916de1bea3bc279b` reports `database_branch_id: work/household-completion-history-2026-10-16`.
- QA #14 requires the stacked #12+#13 source for a real Free registration/confirmation/history session. Its database isolation is **not yet proven**.
- The application uses `@netlify/database`'s `getConnectionString()`; per Netlify docs this resolves the deployment's database branch, but implementation intent does not replace operational verification.

## Required read-only acceptance before creating a QA household
1. Capture newest #14 preview ID, exact commit and deploy context (`deploy-preview`) after this change.
2. Inspect the Netlify Database page / authenticated `netlify database status --branch codex/hosted-auth-qa-2026-10-16` or the platform database-branch API for the new deploy. Never copy a connection string into an issue, log or chat.
3. Confirm preview has an explicit isolated branch distinct from production; prove migration `20261016210000_household_completed_plans.sql` and predecessor schema are present **on that branch only**. If metadata still reads null, stop; do not infer isolation.
4. Prefer safe branch-scoped schema inspection over all-environment variable reads or writing probe records.
5. Once verified, test one new founder-controlled, confirmed identity; then a second independent test household for isolation. Do not reuse real production users or make live Stripe purchases.
6. Verify Free accept != complete, server-owned timestamp, reload/logout/re-login retention and access controls; keep Plus functionality fail-closed.

## Release rule
PR #12 and PR #13 may merge only after verified hosted testing and explicit release criteria. Merge order: #12, reconcile #13 with main, then #13. Never merge QA-only #14; no production billing activation.

Netlify Database docs: https://docs.netlify.com/build/data-and-storage/netlify-database/
Netlify Database API: https://docs.netlify.com/build/data-and-storage/netlify-database/api/
Tracking: https://github.com/Posh-IB/spinFamily/issues/15
