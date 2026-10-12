# SpinFamily household persistence — controlled activation
This branch adds a modern Netlify Identity + Netlify Database Function at /api/household/activities.
- Identity getUser() is verified server-side; do not trust user-supplied IDs.
- Queries derive household ID from the authenticated user and use parameterized SQL.
- Plus requires server-owned subscription status active/trialing AND future current_period_end.
- Moderation runs before insert. Activity creation limit 20 (legacy limit, pending policy review).
- No subscription is granted by this function; no client-controlled premium state.
- No Stripe webhook or checkout correlation has yet been deployed; no household is automatically marked paid.
- Database schema is still a reviewed proposal under docs/, NOT an automatic Netlify migration.
- Before deployment: establish DB branch isolation, provisioning/cost approval, create tables, implement signed Stripe webhook and secure account↔customer linkage, test active/canceled/expired states and household isolation.
- Existing legacy function netlify/functions/custom-activity.cjs is a fail-closed placeholder; do not route UI to it.
- Do not merge to main or publish paid functionality until all release gates pass.
