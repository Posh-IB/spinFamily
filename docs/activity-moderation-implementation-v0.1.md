# Custom activity moderation implementation — preview branch only
- Module: lib/activity-moderation.cjs; tests: tests/activity-moderation.test.cjs.
- This is a **preliminary candidate** moderation policy, not a recovered verbatim founder policy.
- Reject malformed names/categories and explicit prohibited patterns, including common leetspeak and spaced tokens.
- Preserve existing four category IDs and trim names; keep title HTML escaping at UI rendering.
- The module is deliberately independent of the public browser prototype: it must be called by authenticated server create/edit/import handlers after verified Plus entitlement, and before database writes.
- No backend handler, Identity token verification, Stripe webhook, database persistence, or client-side Plus gating has been activated by this change.
- Moderation cannot prove safety from a word list alone. Add human policy review, multilingual/evasion fixtures, contextual false-positive tests and appeal/correction path before allowing unrestricted user-submitted content.
- Treat rejected submissions as non-persisted; log policy version and rule ID without logging rejected text.
- Never expose this as a paid feature unless server authorization and cross-household isolation tests pass.
