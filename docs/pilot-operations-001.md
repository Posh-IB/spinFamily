# SpinFamily Pilot Operations Workspace: engineering record

**Spec:** SF-PILOT-OPS-001 v0.1 Candidate · **Portfolio:** PORT-BASE-025 · **Branch:** `feat/spinfamily-pilot-operations-001` from `landing` @ `a92eec0` · **Date:** 2026-11-24
**Status:** M0–M2 implemented on a branch and tested with synthetic data. **Not production-validated.** Production promotion needs founder approval after independent review (Gideon), and must wait until the Nov 25 9:00 AM ET welcome batch has been reconciled.

## 1. Milestone status

| Milestone | State | Notes |
|---|---|---|
| M0 Reconciliation & architecture | Completed | This record. Branch created from the verified `landing` commit. |
| M1 Secure workspace foundation | Completed, validated locally | Invite-only sign-in, roles, sessions, founder authenticator, audit log, 26 workspace tests. |
| M2 Recruitment operations | Completed, validated locally | Form intake, participant registry, dashboard, follow-ups, outreach log, relationships, materials. |
| M3 Onboarding reconciliation | Pending | Landing-page "Open the app / no download" change, account verification workflow. |
| M4 Research & survey | Pending | Questionnaire draft needs founder/research approval first. |
| M5 RICC evidence integration | Pending | Envelope designed in §8; no RICC writes. |
| M6 Assurance & release | Partly done | Tests, browser QA, dependency audit done. Independent review, accessibility audit with a screen reader and production checks pending. |

## 2. Architecture decisions

**ADR-1: Separate team sign-in, not the app's Netlify Identity.** The app's Identity instance lives on `spinfamily-app` and holds parent accounts; parents must never get workspace access by signing up. The landing project has no Identity instance. Decision: an invite-only, passwordless sign-in built into the landing project's functions. The founder adds people by email; nobody can register. Sign-in links are single-use, expire in 15 minutes, are stored only as SHA-256 hashes, and arrive as a URL fragment (not sent to servers or logs). The link page needs a button press, so email scanners can't use it up.

**ADR-2: Strong authentication for the founder.** Founder access to team management, contact details for all participants, assignments, test-flagging, materials approval, offer approval and the audit log requires a time-based authenticator code (RFC 6238) in the current session. Codes can't be reused; five wrong codes end the session. Coordinators don't hold any of those permissions, so they sign in with the email link only. *Open decision:* require an authenticator for coordinators too.

**ADR-3: Netlify Blobs for storage, behind a small interface.** Blobs is already provisioned on the landing project (the welcome ledger uses it), costs nothing extra at this scale, and supports the conditional writes needed for one-time links and duplicate protection. Production and preview deploys use different stores (`sf-ops-v1-production` / `sf-ops-v1-preview`). All access goes through `lib/ops/store.mjs`, so a move to a dedicated Postgres database later doesn't change the API. *Open decision:* move to Netlify Database (Postgres) once records or reporting outgrow key-value storage; that needs cost approval.

**ADR-4: Server-owned roles.** `lib/ops/permissions.mjs` holds the role matrix. Every request loads the session from the store, re-reads the member and checks the permission on the server. Nothing the browser sends (headers, cookies other than the session, body fields) can change a role.

**ADR-5: Preview access.** Non-production deploys of `spinfamily-landing` already require Netlify team login. On previews only, a team member whose Netlify email is on the workspace team list can sign in with that login. This is disabled in production by code and by test.

## 3. What was added

```
landing-site/lib/ops/security.mjs      tokens, cookies, TOTP
landing-site/lib/ops/permissions.mjs   role matrix
landing-site/lib/ops/store.mjs         storage interface (Blobs + in-memory for tests)
landing-site/lib/ops/api.mjs           all endpoints, intake, dashboard
landing-site/netlify/functions/ops-api.mjs     /operations/api/* (rate-limited 120/min per IP)
landing-site/netlify/functions/ops-intake.mjs  pilot form → participant record (no email)
landing-site/public/operations/        workspace page, script, styles
landing-site/tests/ops.test.mjs        26 tests
netlify.toml                           CSP and no-index headers for /operations/*
```

Not touched: `index.html`, `thanks.html`, `_redirects`, `robots.txt`, the source manifest, `pilot-welcome`, `welcome-batch-20261125`, the app (`main` branch).

## 4. Data model (Blobs keys)

| Key | Holds |
|---|---|
| `members/{id}`, `member-email/{sha256}` | Team member: name, email, title, role, status, authenticator secret |
| `login-links/{sha256(token)}` | One-time link: member, expiry, used flag |
| `sessions/{sha256(sid)}` | Session: member, created, last seen, expiry, authenticator state |
| `participants/{id}`, `participant-email/{sha256}` | Adult participant: first name, email, cohort, enrollment, account, engagement and email states (kept separate), link source from the form (read-only), source reported by the team, assignment, test flag, notes |
| `history/participant/{id}/{ts}` | Append-only change history (write-once keys) |
| `followups/{id}` | Action, subject, due date, assignee, status, outcome |
| `outreach/{id}` | Field report; unknown counts stay null, never 0 |
| `relationships/{id}` | Institutional contact, stage, next action, contact log, offer-approval flag |
| `resources/{id}` | Material link, intended use, approval state |
| `audit/{ts}` | Actor id, action, target id. No names or emails. |

No child names, birthdays, schools, photos or health details are collected. The intake keeps only the form's existing "children under 10" bucket.

## 5. Access-control matrix (as built)

| Capability | Founder | Coordinator |
|---|---|---|
| Dashboard | Yes (all records) | Yes (assigned participants + shared outreach records) |
| Participant records | All | Assigned only; others return "not found" |
| Participant email | All, with authenticator | Assigned only |
| Add participant | Yes | Yes (auto-assigned to them) |
| Update states / notes | Yes | Assigned only |
| Assign, mark as test | With authenticator | No |
| Follow-ups | All | Own only; can assign only to self |
| Outreach log, relationships, contact log | Yes | Yes |
| Approve offers to a relationship | With authenticator | No |
| Materials: view | All | Non-retired |
| Materials: add, approve, retire | With authenticator | No |
| Team: invite, remove, sign out everywhere | With authenticator | No |
| Audit log | With authenticator | No |
| Export, delete participant data, send email | Not built | No |

## 6. Threat model (summary)

| Threat | Control | Test |
|---|---|---|
| Someone signs themselves up | No registration; unknown emails get the same reply and no email | ✓ |
| Finding out who's on the team | Identical response for every email | ✓ |
| Stolen or forwarded sign-in link | Single use, 15 min, hashed at rest, fragment-only, button press | ✓ |
| Link flooding | 3 links per member per 15 min; function rate limit 120/min per IP | ✓ (member) |
| Cross-site request forgery | `__Host-` cookie, SameSite=Strict, Origin check, custom header, JSON only | ✓ |
| Role tampering in the browser | Server-side matrix; client values ignored | ✓ |
| Coordinator reading others' records | Assignment scope enforced on every read | ✓ |
| Compromised founder mailbox | Authenticator code for every privileged action | ✓ |
| Removed member keeps access | Revocation kills sessions immediately | ✓ |
| Idle device left signed in | 8 h idle, 7 day absolute expiry | ✓ |
| Script injection | No HTML parsing of data; CSP `script-src 'self'`, no inline script | ✓ (source check) |
| Preview data leaking into production | Separate stores; preview shortcut off in production | ✓ |
| Duplicate form events | Idempotent intake per email | ✓ |
| Workspace emails parents | Intake never sends; no send endpoint exists | ✓ |
| PII in logs | Audit stores ids/actions only | ✓ |

Residual risks: Blobs has no per-record encryption beyond Netlify's at-rest encryption; the authenticator secret is stored server-side in the same store; there is no IP allow-list; sign-in email depends on the Purelymail mailbox.

## 7. Privacy and tracking inventory (workspace)

No cookies other than the session cookie. No browser storage, analytics, third-party fonts or scripts. `noindex` on page and API. Data destinations: Netlify (hosting, functions, Blobs), Purelymail (sign-in emails to team members only). The public landing page findings in spec §18 (sessionStorage `sf_src`, dormant analytics hooks, Google Fonts, no GPC/consent UI, no CSP on `/`) are **not changed by this branch** and remain open for M6. These are technical controls, not a legal determination.

## 8. RICC evidence mapping (M5 design; nothing sent)

Envelope fields: `eventId, schemaVersion: "sf-pilot-ops/0.1", portfolioRef: "PORT-BASE-025", sourceSystem: "spinfamily-landing/ops", sourceRecordId, eventType, occurredAt, actorRef (member id), department, function, workflowRef, evidenceStatus (actual | field_report | target | unknown), evidenceSourceRef, approvalState, privacyClass (aggregate | pseudonymous), idempotencyKey`.

| Workspace record | RICC function → workflow | Shape |
|---|---|---|
| Outreach log | COMM-COMMUNITY-OPS → WF-COMMUNITY-EVENT; GROW-DEMAND-GEN → WF-MARKETING-DEMAND | Field report, aggregate |
| Relationships | BD-CRM-RELATIONSHIPS / BD-PARTNERSHIPS-SPONSORSHIPS → WF-PARTNER-ENGAGEMENT | Stage changes, pseudonymous |
| Participant states | GROW-MARKETING-ANALYTICS; RINT-EVIDENCE-MGMT → WF-VENTURE-VALIDATION (candidate) | Aggregate counts only |
| Security and access events | PENG-SECURITY-ENG / GOV-COMPLIANCE-CONTROL → WF-SECURITY-RISK-REVIEW | Pseudonymous |

Destinations must be validated against the current RICC build before anything is staged. Historical routing matrix (PR #109, closed unmerged) is not treated as active.

## 9. Cost

None new. Uses existing Netlify Pro functions and Blobs on `spinfamily-landing` and the existing Purelymail mailbox. A Postgres move (ADR-3) or a paid email provider would need approval.

## 10. Release and rollback plan

1. Wait until the Nov 25 batch has run and its results are reconciled; retire its temporary configuration per the spec.
2. Independent review (Gideon) of this branch and record.
3. Founder approval to merge the draft PR into `landing`.
4. After deploy: founder requests a sign-in link at `spinfamilyapp.com/operations/`, sets up the authenticator, adds Lindsey, and both run the checklist in §11.
5. Check that `pilot-welcome` still sends exactly one welcome per new form submission and `ops-intake` creates one participant record.

Rollback: redeploy the previous production deploy in Netlify (instant), or revert the merge commit. The workspace keeps its data in its own Blobs store; rolling back leaves it untouched and changes nothing in the welcome ledger.

## 11. Open issues and approvals

| # | Item | Owner |
|---|---|---|
| 1 | Approve this branch for production after review | Founder, Gideon |
| 2 | Confirm SMTP variables are available to functions in production (and decide whether previews should send sign-in email) | Founder |
| 3 | Decide whether coordinators also need an authenticator | Founder |
| 4 | Enter the 3 existing beta testers, current pilot registrations and the Cincinnati State contacts after launch (kept out of the public repo on purpose) | Founder |
| 5 | Backfill earlier form submissions (needs a narrowly scoped Netlify token or manual entry) | Founder |
| 6 | M3: add "Open SpinFamily App, no download needed" to the form success state and thank-you page (requires deliberate source-manifest update) | Claude |
| 7 | M3: account verification against the app's Identity without exposing the user list | Claude, Founder |
| 8 | M4: approve the parent questionnaire before it is published | Founder |
| 9 | Landing-page privacy items from spec §18 | Claude, Compliance |
| 10 | Postgres migration decision (ADR-3) | Founder |
