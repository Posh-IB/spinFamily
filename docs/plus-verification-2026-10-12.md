# Isolated Plus lifecycle engineering evidence

Draft candidate; not released. The existing presentation review remains untouched.

Implemented: server-owned household resolution, sandbox-only checkout claims, raw-body signature validation, transactional subscription reconciliation, event idempotency, single-use claims, terminal cancellation protection, scoped activity CRUD and moderation. Account controls are additive on Family; guest wheel and session activity behavior remain intact. Build delivery is limited to index, artwork and the Identity client bundle.

Executed locally: 53 application tests pass. SQL migrations apply against PGlite; provider responses are synthetic fixtures. Four modern function bundles compile. PGlite advisory lock calls are omitted by the test adapter; real PostgreSQL concurrency is not verified. No actual payment or hosted identity lifecycle is certified by these tests.

Hosted builds are held by the Netlify ignore command until a synthetic-only preview database and migration history can be inspected. Runtime also requires platform preview context and explicit isolation confirmation. No hosted migration was executed.

Local Chromium installation failed with a truncated archive. A GitHub Actions job provides repeatable mobile/desktop guest, wheel, artwork and fallback checks; authored checks count only after successful execution. Hosted identity, purchase, refresh/sign-in persistence and lifecycle browser checks remain open.

Release recommendation: hold production and preview activation pending verified isolation, sandbox configuration, real lifecycle tests and browser evidence. No production merge, production deployment, live billing change or third-party AI activation.
