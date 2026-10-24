# SpinFamily controlled integration — October 24, 2026

Candidate based on public PR #18 (d30eb843) and private PR #10 (70b2c601). No production merge or deployment is authorized.

## Changes
- Preserve PostgreSQL microsecond precision in keyset history cursors; return completion dates as text and add a household/page index.
- Add a PostgreSQL gate covering 137 tightly timestamped rows, tenant-bound cursors, duplicate/concurrent writes and completion, local completion-day aggregation, deletion and the 10,000-row cap.
- Include only server-authorized household custom activities with explicit feasibility metadata in the private catalog. Existing or unconfirmed/outdoor/away activities remain outside suggestions.
- Connect Today, Tomorrow, future date and daypart/custom-window controls through the private scheduling resolver. Keep household timezones, explicit completion feedback, exclusions, routines and must-include constraints server-owned. Hide planning controls on entitlement loss and discard stale results.
- Keep private planning/ranking implementation in the private repository. The existing /v1/next-day transport accepts the additive schedule field for compatibility.

## Verification so far
- Private full suite: 164 passed, 0 failed; separate new scheduling integration: 2 passed, 0 failed.
- Public unit suite: 52 passed, 0 failed, 3 PostgreSQL tests skipped without a database URL. Public build passed. Later focused checks and browser results are recorded separately.
- GitHub private run 40136219673 failed before any step: account payments failed or spending limit needs increasing. No billing limit or payment settings changed.
- Local PostgreSQL execution is blocked: Docker daemon was stopped; after starting Desktop, its local engine API returns Internal Server Error. No PostgreSQL pass is claimed from skipped tests.
- Existing QA deploy 6ad2eea19ff4ca983928b897 serves older public commit cd4c292, context deploy-preview; database_branch_id and database_migrations are null. Private engine URL/token are absent from site environment metadata. No hosted account/household writes or private transport success is claimed.

## Release gates still required
Run the PostgreSQL and actual private-engine lifecycle gates; restore private CI account billing; verify an isolated preview database and applied migrations, configure the preview-only authenticated private service, and complete real Identity/Plus/reload/logout browser QA at 390/1440. Never merge QA-only PR #14. Production merge and deployment require explicit approval.
