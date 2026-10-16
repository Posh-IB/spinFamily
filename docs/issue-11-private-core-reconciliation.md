# SpinFamily Issue #11 — Private-core reconciliation and cloud history boundary
Status: **candidate implementation, branch only; not production deployed**.

## Recovered existing IP and evidence

Private repo `Posh-IB/spinFamily-core`, branch `work/wp2-household-tonight-2026-10-10`:
- `src/state.js`: schemaVersion 2, catalogVersion `home-demo-1`, revision, explicit preferences, and accepted records with **separate optional caregiver completion**. Acceptance duplicates are idempotent; completion cannot precede acceptance; completion duplicates retain original timestamp. History derived from stored accepted/completed records.
- `public/storage.js`: browser `spinfamily.household.v2`, recovery snapshot, original backup, atomic localStorage writes, stale-tab expected-value guard, recovery and explicit deletion.
- `src/server.js`: private local-preview HTTP accept/complete/validate endpoints.
- `docs/WP2-EVIDENCE.md`: 118 cases passing in original private gate; next-gate report 120 passing, but actual browser UI and hosted cloud sync were not verified.
- Private code stores no persistent cloud history. Its demo catalog `home-demo-1` and strict approval envelope cannot be silently transplanted onto the public curated catalog or purported to validate the current browser scheduler.
- Streak statistics **not implemented** there; earlier vNext suggested one completed plan per household local day and continuation from yesterday, but final authority over streak policy remains reviewable.

## Public app integration strategy

Public main already has `saved_plans` in its second Netlify DB migration. The additive migration here extends this **same table**, avoiding duplicate history storage.
- Each signed-in household owns its immutable accepted plan snapshot and optional `completed_at`; server stamps acceptance/completion and records `completion_source='explicit_caregiver'`.
- Event semantics match private core without copying any protected ranking/planning/search source or claiming full byte-level storage contract compatibility.
- Schema has per-household idempotent client UUID, immutable snapshots, household-owned completion events, and check constraint prohibiting completion before acceptance.
- New pure `lib/plan-history.cjs` handles only safe schema validation and derived progress views. It is *not* the planner or recommender.
- **Founder-ratified streak rule (2026-10-16):** The household earns one streak day after a caregiver confirms completing at least one **entire family plan** on that household-local calendar day. Completing multiple full plans on the same day still yields only one streak day; accepting a plan, spinning, or marking a partial activity does not count. Current streak remains live when most recent completed day is today or yesterday; longest is limited to retained history. Invite families to return tomorrow for meaningful quality time with a different activity mix, without making variety a condition of streak credit. Routines, caregiver choices and practical constraints remain authoritative.
- All household history is Plus-only in line with existing premium features. Guest spinning/selection remain free and ephemeral.
- Persistent history currently capped to 100 plans (matching private core); no automatic deletion. Explicit deletion is required for correction/capacity, and service should handle retries and authorization.
- Accepting a plan is not asserting its scheduled activities were physically performed; completing is an *explicit caregiver attestation*, not independent third-party verification.

## Release gate

Integration tests for server/db permissions, duplicate acceptance/completion, timestamps, timezone boundaries, deletion, retries, logout and mobile/desktop UI remain required. No production merge until tests and founder review.
