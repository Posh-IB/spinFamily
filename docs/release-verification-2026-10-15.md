# Release verification — October 15, 2026

Status: candidate hardening; NOT production qualified.

This branch retains the PR #7 frontend/artwork and adds fixes for confirmed release defects:
- PostgreSQL serialization and persistent idempotency for concurrent checkout attempts.
- Provider subscription lookup before accepting another subscription purchase.
- Authoritative subscription retrieval inside serialized webhook processing; paid-invoice evidence and terminal-state enforcement.
- Transactional household/entitlement checks and a database-enforced 20-activity limit.
- Platform deployment context and runtime environment access; production requires an explicit live gate.
- Client checkout readiness, Identity settings discovery, stale-response/logout guards, bounded image fallbacks.
- Reproducible dependency lock and integration tests against real PostgreSQL and synthetic signed Stripe events.

Local unit tests and static build are preliminary evidence only. PostgreSQL CI, hosted migration/function verification, actual Identity lifecycle and Stripe QA checkout remain required. This candidate must not be merged/published until those checks pass. No live charge/refund test is authorized.

Database changes are additive; prior migrations are preserved. Recovery uses a corrective commit and compatible migration, never a destructive schema reset. Existing subscription records require fresh verified webhook reconciliation before paid access can be granted.
