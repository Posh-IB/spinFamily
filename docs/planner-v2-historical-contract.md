# SpinFamily Planner v2 — Recovered Rules & Custom Activity Contract
Status: historical reconciliation, not an implementation approval or production migration.

## Recovered direction (Sept 1–Oct 11, 2026)
- Deterministic Planner Engine v2 precedes any ML; wheel chooses anchor category, constrained scheduler composes plan.
- Default current local time and 120-minute horizon; logical variation, chores/setup earlier, family/outdoor middle, unwind later; bedtime last unless caregiver explicitly overrides.
- Feasibility (duration, age suitability, accessibility, budget, travel, fixed events, context) is a hard filter before preference ranking. Unavailable context must not be silently inferred.
- Weighted selection considers explicit preference, novelty, category balance, household fit and repetition. Constrained randomness maintains variety.
- Remember accepted plans, rejected plans, swaps, skips, completions, favorites, respins, manual additions, pins, exclusions, caregiver-confirmed routines, and recent category distribution.
- Preserve intentional routines: never apply anti-repeat penalties to explicitly confirmed routines as if they were unwanted repetition.
- Local-first history, validated recovery/import/export/deletion; household-scoped storage only when authenticated and entitled; never profile children.
- Protect original wheel, public experience, baseline and production; avoid moving protected private-core algorithms into public HTML.

## Existing public custom-add contract (verified against branch HTML)
- Name entered as trimmed text; category selected from four internal categories (chore/outdoor/family/selfcare).
- Empty name rejected; 20-item session cap; limited prohibited-word patterns rejected; title HTML-escaped.
- Existing additions have a fixed 20-minute scheduling estimate, appear in activity list, and enter allActivities() planning pool.
- The old behavior is ephemeral and does not prove moderation, validated duration, duplicate control, age/accessibility suitability or persistence.
- Custom entries must not silently become curated trusted catalog records.

## New Plus policy (founder Oct 12)
- Only verified Plus households may add custom activities or persist saved activities and history after refresh/logout.
- Plus supports repeat recognition, swaps, anti-monotony, week-level tailored plans; not backend/database/admin access.
- Stripe product/links already exist; entitlement must be server verified and cannot be activated by a success redirect.
- Guest can spin and browse curated catalog without signup.

## Implementation preservation rules
1. Do not remove the existing activity-category association, family-friendly screening, HTML escaping or explicit session cap until a replacement contract is approved.
2. Custom activity duration 20 minutes is legacy behavior, not validated user intent. Store source=custom and duration_source=legacy_default until duration entry/validation is explicitly approved.
3. Do not silently infer duplicate policy, new duration fields, cross-category reuse, moderation sufficiency, or suitability rules: mark as unresolved.
4. The Plus add form must not appear as functional to a non-entitled account. Keep public guest behavior intact while introducing a clear, accessible Plus gate.
5. For existing anonymous custom activities, never silently upload; require an explicit opt-in migration after authentication and entitlement verification.
6. Track accepted/completed/swapped/skipped separately from suggested; retain caregiver override and intentional routines as first-class signals.
7. Before backend implementation, write regression tests for original add behavior and new Plus boundaries, including injection, invalid category, limit, duplicates (pending decision), token expiry and cross-household access.

## Open decisions requiring source recovery or founder confirmation
- Exact approved custom activity form fields beyond title and category.
- Whether duplicate names are permitted across categories or within a household.
- Whether caregivers can supply activity duration or the default remains 20 minutes.
- Whether custom activities require caregiver age/accessibility suitability confirmation before recommendation.
- Limits for paid persistent custom activities versus historical 20-session limit.
- Precise previous private WP2 data contracts and conflict-resolution rules.

No changes to production, Stripe, Identity, database or paid activation are authorized by this record.
