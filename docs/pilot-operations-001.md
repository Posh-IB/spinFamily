# SpinFamily Pilot Operations Workspace: engineering record

**Spec:** SF-PILOT-OPS-001 v0.1 Candidate · **Portfolio:** PORT-BASE-025 · **Branch:** `feat/spinfamily-pilot-operations-001` from `landing` @ `a92eec0` · **PR:** #28 (draft) · **Updated:** 2026-11-25
**Status:** Built on a branch and tested with synthetic data on a local Postgres. **Not production-validated.** Production waits for: the Nov 25 9:00 AM ET welcome batch to be reconciled, Gideon's independent retest of this remediation, and founder approval.

## 1. Milestone status

| Milestone | State |
|---|---|
| M0 Reconciliation & architecture | Completed |
| M1 Secure workspace foundation | Completed; remediated for IR-01, IR-02, IR-06, IR-07; validated locally |
| M2 Recruitment operations | Completed; remediated for IR-03, IR-04, IR-05, IR-09; validated locally |
| M2.1 Company docs | Completed, validated locally |
| M2.2 Approvals inbox | Completed, validated locally (new, founder request Nov 24) |
| M2.3 Social calendar | Completed, validated locally (new) |
| M3 Onboarding reconciliation | Pending (landing-page "no download" change, account verification against the app) |
| M4 Research & survey | Built: cohorts, sessions, versioned questionnaire (draft from §15, needs founder approval), one-time survey links, role-scoped results. Pending: founder approval of the wording, live use |
| M5 RICC evidence integration | Designed (§9), nothing sent |
| M6 Assurance & release | Partial: 55 automated tests, browser QA, dependency audit. Pending: Gideon retest, manual screen-reader pass, first production checks |

## 2. Architecture decisions

**ADR-1 Separate team sign-in.** Invite-only passwordless email links on the landing project. Parents' app accounts (Netlify Identity on `spinfamily-app`) never grant workspace access. Links are single-use, 15 minutes, stored as hashes, delivered as a URL fragment, and need a button press.

**ADR-2 (revised for IR-07) Authenticator for everyone.** Every team member enrolls a TOTP authenticator and enters a code at every sign-in before any data loads. The founder's *first* enrollment, and any founder recovery, requires the one-time setup code stored in Netlify as `OPS_FOUNDER_ENROLLMENT_CODE`. That proves control of the hosting account, not just the mailbox. The founder can reset a teammate's authenticator.

**ADR-3 (revised) Netlify Database (Postgres) for records; Netlify Blobs for file bytes.** Founder approved the move on Nov 24. Postgres gives atomic conditional updates, unique constraints and row locks, which close the race findings in IR-01/04/05 by construction. Uploaded files stay in Blobs: a site-wide store in production and a deploy-scoped store per preview. Netlify gives each deploy preview its own database branch forked from production. Preview branches can therefore contain real data once production has some, and previews only open with Netlify team login. Cost: Netlify Database uses credits for compute while active (storage currently free). Each open preview uses one branch.

**ADR-4 Multi-company from the start.** Every table carries `org_id`; people hold a role per organization through `memberships`. This deployment serves `spinfamily`. Another Rootlayer product can run the same code with its own org id, or a shared Rootlayer workspace can add an org switcher later, without schema changes.

**ADR-5 Server-owned roles.** `lib/ops/permissions.mjs` is the only place roles are defined. Every request re-loads the session and membership from the database.

**ADR-6 (revised for IR-02) Fail closed outside production.** `lib/ops/runtime.mjs` treats a request as production only when Netlify's runtime metadata says `production` **and** the site id is `spinfamily-landing`'s. Otherwise: no production files, no email from the real mailbox, and no form intake. On previews, sign-in uses Netlify team login instead of email.

## 3. Gideon's review (baseline `abee66d`): remediation

| Finding | What changed | Tests |
|---|---|---|
| **IR-01** auth/revocation races | Link claims, TOTP step use (shared across sessions), failure counters and link throttling are single atomic SQL statements. Revoke, restore, sign-out-everywhere, email change and authenticator reset cancel every outstanding link. Sessions created in the same millisecond as a revocation are rejected (`<=`). Logout deletes the row; refresh only updates an existing row, so it can't recreate a session. | parallel link use; 10 parallel link requests → 3 emails; parallel same-code MFA in two sessions → one succeeds; 5 parallel wrong codes end the session; link requested before revoke is dead after restore; verify-vs-revoke interleaving; logout-vs-refresh |
| **IR-02** fail-open intake / preview boundary | Intake requires confirmed production site + context, otherwise logs `skipped_not_production` and writes nothing. API refuses unknown sites (503). Previews use deploy-scoped file storage and their own database branch. Email is blocked outside production. | runtime facts for missing/unknown context and wrong site; source checks on both functions |
| **IR-03** evidence integrity | Account/engagement/email states carry a `verified` flag. Anything a teammate enters is "reported"; only the founder (with authenticator) can mark a state verified, and must say how. A later edit clears verification. Only the founder changes cohort. Registrations count only form/imported records confirmed not to be tests; unreviewed and hand-added records are shown separately. Repeat use counts only verified "repeat use observed" (a survey or pilot completion isn't evidence of return). | coordinator cannot inflate any verified metric; evidence note required; verification cleared by later edits; test and unreviewed records excluded |
| **IR-04** intake reliability & provenance | Intake uses the welcome email's strict `parsePilot`. A single atomic insert per email; no separate "claim" that can be stranded. Every distinct delivery goes into an append-only `pilot_intake_records` ledger with payload hash, Netlify submission id **only if the event carries one** (otherwise `event_without_id`, never invented), source timestamp, consent purpose, `heard_from` and outcome. Exact redeliveries are ignored. A hand-added prospect who later registers is promoted while keeping both sources. Intake never sends email. | strict-parser rejections; 3 parallel identical deliveries → 1 participant, 1 ledger row; redelivery adds no history; id-less provenance; prospect promotion and later link |
| **IR-05** concurrent authorization/state writes | Participants and relationships carry a `version`; every edit must name the version it read (compare-and-set). Participant edits re-check the editor's scope in the same statement. Offer approval is its own founder-only update and can't be overwritten by a notes save. Coordinators edit only relationships they own or added (anyone can log contact). Founder assignment on create uses the same authenticator check and active-member validation as reassignment. | stale coordinator edit after reassignment → refused, assignment intact; two founder tabs → second refused; offer approval survives a stale notes save; ownership check |
| **IR-06** retention, cleanup, errors | Expired links and sessions are purged on each sign-in request. Error logs carry only error class, database code and route, never values. The error message no longer claims nothing changed. A failed audit write is logged and never turns a completed change into an error. History, audit, intake ledger, relationship log and survey answers are append-only at the database level (triggers). **Open:** retention periods, deletion/withdrawal workflow (§10). | error log has no email; append-only triggers reject UPDATE/DELETE |
| **IR-07** bootstrap & coordinator MFA | See ADR-2. Lists are bounded (`LIMIT`). | founder setup locked without the Netlify code; wrong code rejected; recovery path; coordinator blocked from all data until enrolled |
| **IR-08** open landing items | Unchanged and still open: A01–A04 landing privacy/onboarding fixes, A07 account confirmation/activation reconciliation, A10 live accessibility check. A11 (Nov 25 batch) preserved: no changes to `welcome-batch-20261125` or `pilot-welcome`. | source checks |
| **IR-09** authorized backfill | Founder-only import (with authenticator) of earlier form submissions or beta users, with source, export date and submitted date recorded per row; existing emails skipped; imported rows start as "not reviewed". Until the founder marks the backfill complete, the dashboard labels registration and beta counts **incomplete** instead of implying zero. No PII in code. | provenance kept; duplicates skipped; incomplete → actual only after backfill |

## 4. What's in the branch

```
landing-site/netlify/database/migrations/20261125020000_ops_foundation.sql   schema (orgs, memberships, records, ledgers, append-only triggers)
landing-site/lib/ops/core.mjs        routing, sign-in, sessions, authenticator, team, audit
landing-site/lib/ops/records.mjs     participants, intake, import, follow-ups, outreach, relationships, dashboard
landing-site/lib/ops/docs.mjs        Company docs (metadata in Postgres, files in Blobs)
landing-site/lib/ops/approvals.mjs   Approvals inbox
landing-site/lib/ops/content.mjs     Social calendar
landing-site/lib/ops/research.mjs    Cohorts, sessions, questionnaire, survey links, results; public survey endpoints
landing-site/lib/ops/{security,permissions,util,files,runtime}.mjs
landing-site/netlify/functions/ops-api.mjs     /operations/api/* (rate-limited)
landing-site/netlify/functions/ops-intake.mjs  pilot form → participant (production only, no email)
landing-site/public/operations/      team workspace
landing-site/public/pilot/survey/    parent questionnaire page (one-time links)
landing-site/tests/ops.test.mjs      40 workspace tests on Postgres (55 in the whole suite)
netlify.toml                         CSP / no-index / no-store headers for /operations/* and /pilot/survey/*
```
Not touched: `index.html`, `thanks.html`, `_redirects`, `robots.txt`, source manifest, `pilot-welcome`, `welcome-batch-20261125`, the app (`main`).

## 5. Access matrix (as built)

| Capability | Founder | Coordinator |
|---|---|---|
| Any data | After authenticator code | After authenticator code |
| Participants | All; contact details for all | Assigned only, with contact details |
| States (account/engagement/email) | Set and **verify** with evidence | Set as **reported** only |
| Cohort, assign, mark test, import | Yes | No |
| Follow-ups | All | Own only |
| Outreach log | Yes | Yes |
| Relationships | Edit any; approve offers | Edit own; log contact on any; request offer approval |
| Company docs | Upload, share, approve, retire | View shared; upload goes to founder for review |
| Approvals | Decide (once per item; note required for changes) | Submit messages/offers; see own; withdraw |
| Social calendar | All | Draft, submit, mark posted after approval |
| Research | Create groups, approve questionnaire, full results | Add assigned people to groups, log sessions, create survey links for assigned people, summary results (no written answers) |
| Team, audit log | Yes | No |
| Export, delete participant data | Not built | No |

## 6. Threat model (additions since baseline)

Approvals can be decided only once (atomic). Content can't be marked posted unless approved, and an approved post that is edited returns to draft. Survey links are single-use under parallel submits, expire in 30 days, are stored as hashes, carry no participant details, and accept only answers to the questionnaire's own questions. A questionnaire can't be sent until the founder approves it; approved versions are never edited (edits create a new version, answers keep theirs). Uploaded files: type checked from bytes, served as downloads with `nosniff` and a sandbox CSP, 4 MB cap, not virus-scanned.

Residual risks: preview database branches can hold production data copies (previews are behind Netlify team login); files aren't virus-scanned; the authenticator secret lives in the same database; sign-in depends on the Purelymail mailbox; the Netlify form event's id/timestamp fields are not confirmed. Intake records `event_without_id` until a real production event shows what Netlify sends.

## 7. Founder setup before launch

1. In Netlify → `spinfamily-landing` → Project configuration → Environment variables, add `OPS_FOUNDER_ENROLLMENT_CODE` (a long random phrase you keep somewhere safe), scoped to Functions, all deploy contexts.
2. Confirm the SMTP variables are available to Functions in production (the welcome email already depends on them).
3. After launch: sign in at `spinfamilyapp.com/operations/`, set up your authenticator with the setup code, add Lindsey at `lindseywhitaker@spinfamilyapp.com`, import earlier sign-ups and beta testers, and mark the backfill complete.

## 8. Privacy and tracking (workspace)

Session cookie only. No browser storage, analytics, third-party fonts or scripts. `noindex` everywhere. Destinations: Netlify (hosting, functions, Database, Blobs) and Purelymail (team sign-in and notification emails; no parent emails are sent by the workspace). Questionnaire is optional throughout and asks nothing about children's identities. The public landing-page findings in spec §18 are not changed by this branch. These are technical controls, not a legal determination.

## 9. RICC evidence mapping (M5 design; nothing sent)

Envelope: `eventId, schemaVersion "sf-pilot-ops/0.1", portfolioRef "PORT-BASE-025", sourceSystem "spinfamily-landing/ops", orgId, sourceRecordId, eventType, occurredAt, actorRef, department, function, workflowRef, evidenceStatus (verified | reported | field_report | target | unknown | incomplete), evidenceSourceRef, approvalState, privacyClass (aggregate | pseudonymous), idempotencyKey`.

| Workspace source | RICC function → workflow |
|---|---|
| Outreach log | COMM-COMMUNITY-OPS → WF-COMMUNITY-EVENT; GROW-DEMAND-GEN → WF-MARKETING-DEMAND |
| Social calendar | GROW-DEMAND-GEN → WF-MARKETING-DEMAND; GROW-MARKETING-ANALYTICS |
| Relationships, offer approvals | BD-CRM-RELATIONSHIPS / BD-PARTNERSHIPS-SPONSORSHIPS → WF-PARTNER-ENGAGEMENT |
| Participant states (verified only), intake ledger | GROW-MARKETING-ANALYTICS; RINT-EVIDENCE-MGMT → WF-VENTURE-VALIDATION (candidate) |
| Research cohorts, questionnaire results (aggregate) | RINT-RESEARCH / RINT-EVALUATION → WF-VENTURE-VALIDATION (candidate) |
| Approvals | EXEC / OPS-WORKFLOW → MOTR-WEEKLY-RECON |
| Access and security events | PENG-SECURITY-ENG / GOV-COMPLIANCE-CONTROL → WF-SECURITY-RISK-REVIEW |

Destinations to be validated against the current RICC build and its independent gates (rootlayer-intelligence-command-center PR #223) before anything is staged.

## 10. Open decisions and approvals

| # | Item | Owner |
|---|---|---|
| 1 | Independent retest of this remediation; production approval after the Nov 25 batch is reconciled | Gideon, Founder |
| 2 | Set `OPS_FOUNDER_ENROLLMENT_CODE`; confirm SMTP variables for production functions | Founder |
| 3 | Retention periods and a participant deletion/withdrawal workflow (append-only history means deletion needs a governed redaction design) | Founder, Compliance |
| 4 | Approve the questionnaire wording (v1 draft in the workspace) | Founder |
| 5 | Confirm Netlify Database credit usage is acceptable on the team plan | Founder |
| 6 | Verify the form event's id/timestamp fields on the first production submission (intake logs provenance) | Claude, after launch |
| 7 | M3: "Open SpinFamily, no download needed" on the form success state and thank-you page (source-manifest update) | Claude |
| 8 | M3: account verification against the app's Identity without exposing the user list | Claude, Founder |
| 9 | Landing-page privacy items (spec §18, A01–A04) | Claude, Compliance |
| 10 | Remaining departments planned Nov 24: participant support, partnerships pipeline, product feedback, people/onboarding, finance (light), privacy requests, weekly reporting | Founder to prioritize |

## 11. Release and rollback

Release: after items 1–2 above, merge PR #28 into `landing`. Netlify applies the database migration before publishing (a failed migration blocks the publish). Then follow §7 step 3.
Rollback: redeploy the previous production deploy in Netlify. The migration only adds new tables, so the previous code is unaffected. No existing table or file is changed. Workspace data stays in its own tables and isn't deleted by a rollback.
