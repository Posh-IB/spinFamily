-- SF-PILOT-OPS-001 R2 remediation (PR #28 review 6051609689: R2-01..R2-05).
-- A new migration: the applied foundation migration is never edited.

-- ===================== R2-01: sign-in generations =====================
-- Every change to someone's access (email change, revoke, restore, sign out everywhere,
-- authenticator reset or recovery, new authenticator) bumps auth_generation inside a locked
-- transaction. Links and sessions carry the generation they were issued under and stop
-- working the moment it moves on.
ALTER TABLE members ADD COLUMN auth_generation bigint NOT NULL DEFAULT 1;
ALTER TABLE members ADD COLUMN mfa_failures jsonb NOT NULL DEFAULT '[]';   -- recent wrong codes for this person, across sessions
ALTER TABLE login_links ADD COLUMN auth_generation bigint;                 -- NULL = issued before this migration: never accepted
ALTER TABLE login_links ADD COLUMN email text;                             -- the address the link was sent to
ALTER TABLE sessions ADD COLUMN auth_generation bigint;                    -- NULL = created before this migration: never accepted
UPDATE login_links SET used_at = 0 WHERE used_at IS NULL;                  -- cancel every outstanding pre-migration link
DELETE FROM sessions;                                                      -- everyone signs in again under the new rules

-- One-time secrets: the founder bootstrap code works once per organization; each recovery code
-- value works once. Only hashes are stored.
CREATE TABLE secret_uses (
  org_id       text NOT NULL REFERENCES orgs(id),
  purpose      text NOT NULL CHECK (purpose IN ('founder_bootstrap', 'founder_recovery')),
  secret_hash  text NOT NULL,
  context      text NOT NULL,
  member_id    text NOT NULL REFERENCES members(id),
  used_at      timestamptz NOT NULL,
  PRIMARY KEY (org_id, purpose, secret_hash)
);
CREATE UNIQUE INDEX secret_uses_one_bootstrap ON secret_uses (org_id) WHERE purpose = 'founder_bootstrap';

-- ===================== R2-02: database environment marker =====================
-- Production writes 'production' the first time it runs. A preview database forked from it
-- inherits that marker and refuses to serve. A preview only serves data from a database that
-- is empty when first seen (it then writes 'synthetic'). Production refuses a 'synthetic' one.
CREATE TABLE ops_environment (
  singleton    boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  kind         text NOT NULL CHECK (kind IN ('production', 'synthetic')),
  site_id      text NOT NULL,
  context      text NOT NULL,
  marked_at    timestamptz NOT NULL
);

-- ===================== R2-03: evidence-driven records =====================
ALTER TABLE participants ADD COLUMN household_key text;   -- founder-entered; NULL = counted as their own household
ALTER TABLE participants ADD COLUMN withdrawn_at timestamptz;

-- Which programs a person is in, each backed by evidence. A person can be in several.
CREATE TABLE cohort_memberships (
  org_id          text NOT NULL REFERENCES orgs(id),
  participant_id  text NOT NULL REFERENCES participants(id),
  cohort          text NOT NULL CHECK (cohort IN ('pilot', 'beta', 'research')),
  status          text NOT NULL CHECK (status IN ('active', 'withdrawn')),
  evidence_kind   text NOT NULL CHECK (evidence_kind IN ('pilot_form', 'founder_import', 'founder_record')),
  evidence_ref    text NOT NULL,            -- intake ledger id, import receipt id, or founder note
  joined_at       timestamptz NOT NULL,
  left_at         timestamptz,
  recorded_by     text NOT NULL,
  PRIMARY KEY (org_id, participant_id, cohort)
);

-- Backfill: each import names its export and how many rows it should contain; completion
-- needs a reconciled receipt for every required source.
CREATE TABLE backfill_receipts (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES orgs(id),
  source          text NOT NULL CHECK (source IN ('netlify_forms_export', 'app_identity_export', 'founder_records')),
  export_ref      text NOT NULL,            -- file name or export id the founder used
  export_sha256   text,                     -- checksum of the export file, if provided
  exported_at     date NOT NULL,
  expected_count  int NOT NULL CHECK (expected_count >= 0),
  received_count  int NOT NULL,
  created_count   int NOT NULL,
  linked_count    int NOT NULL,
  duplicate_count int NOT NULL,
  conflict_count  int NOT NULL,
  reconciled      boolean NOT NULL,
  created_by      text NOT NULL REFERENCES members(id),
  created_at      timestamptz NOT NULL
);
ALTER TABLE pilot_intake_records ADD COLUMN receipt_id text REFERENCES backfill_receipts(id);
ALTER TABLE pilot_intake_records ADD COLUMN cohort text NOT NULL DEFAULT 'pilot';

-- Same source submission id arriving with different content: held for founder review, never merged.
CREATE TABLE intake_conflicts (
  id                    text PRIMARY KEY,
  org_id                text NOT NULL REFERENCES orgs(id),
  source_submission_id  text NOT NULL,
  existing_record_id    text NOT NULL REFERENCES pilot_intake_records(id),
  payload_hash          text NOT NULL,
  provenance            text NOT NULL,
  receipt_id            text REFERENCES backfill_receipts(id),
  received_at           timestamptz NOT NULL,
  status                text NOT NULL CHECK (status IN ('open', 'resolved')),
  resolution            text NOT NULL DEFAULT '',
  resolved_by           text,
  resolved_at           timestamptz,
  UNIQUE (org_id, source_submission_id, payload_hash)
);

-- Governed redaction: append-only tables accept an UPDATE only inside a transaction that set
-- ops.redaction = 'on' (the founder's redaction workflow, which records a redaction_events row).
CREATE TABLE redaction_events (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES orgs(id),
  participant_id  text NOT NULL REFERENCES participants(id),
  reason          text NOT NULL,
  request_ref     text NOT NULL DEFAULT '',
  performed_by    text NOT NULL REFERENCES members(id),
  performed_at    timestamptz NOT NULL,
  counts          jsonb NOT NULL
);
CREATE OR REPLACE FUNCTION ops_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('ops.redaction', true) = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'append-only table: % is not allowed on %', TG_OP, TG_TABLE_NAME;
END;
$$;

-- ===================== R2-04: approval integrity =====================
ALTER TABLE approvals DROP CONSTRAINT approvals_status_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_status_check CHECK (status IN ('pending', 'approved', 'changes_requested', 'withdrawn', 'superseded'));
ALTER TABLE approvals ADD COLUMN item_version int;
ALTER TABLE approvals ADD COLUMN snapshot jsonb;      -- the complete content that was reviewed
ALTER TABLE approvals ADD COLUMN digest text;         -- SHA-256 of the snapshot
-- Requests made before snapshots existed can't be decided safely: they must be sent again.
UPDATE approvals SET status = 'superseded', decision_note = 'Sent before review snapshots existed. Send it again.' WHERE status = 'pending';
CREATE UNIQUE INDEX approvals_one_pending ON approvals (org_id, item_type, item_id) WHERE status = 'pending' AND item_id IS NOT NULL;

ALTER TABLE content_posts ADD COLUMN version int NOT NULL DEFAULT 1;
UPDATE content_posts SET status = 'draft' WHERE status = 'in_review';
ALTER TABLE documents ADD COLUMN version int NOT NULL DEFAULT 1;
ALTER TABLE documents ADD COLUMN file_sha256 text;
ALTER TABLE survey_definitions ADD COLUMN revision int NOT NULL DEFAULT 1;   -- bumps on every draft edit
CREATE UNIQUE INDEX survey_one_approved ON survey_definitions (org_id, title) WHERE status = 'approved';

-- Notifications are written in the same transaction as the change and sent after commit.
CREATE TABLE notifications_outbox (
  id               text PRIMARY KEY,
  org_id           text NOT NULL REFERENCES orgs(id),
  member_id        text NOT NULL REFERENCES members(id),
  subject          text NOT NULL,
  body             text NOT NULL,
  created_at       timestamptz NOT NULL,
  sent_at          timestamptz,
  attempts         int NOT NULL DEFAULT 0,
  last_attempt_at  timestamptz,
  last_error       text
);
CREATE INDEX notifications_outbox_unsent ON notifications_outbox (org_id, created_at) WHERE sent_at IS NULL;

-- ===================== R2-05: research consent and survey integrity =====================
CREATE TABLE research_consents (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES orgs(id),
  participant_id    text NOT NULL REFERENCES participants(id),
  purpose           text NOT NULL CHECK (purpose IN ('pilot_research')),
  notice_version    text NOT NULL,
  method            text NOT NULL CHECK (method IN ('participant_survey_page', 'founder_recorded_written')),
  evidence          text NOT NULL DEFAULT '',
  given_at          timestamptz NOT NULL,
  recorded_by       text NOT NULL,
  withdrawn_at      timestamptz,
  withdrawal_method text,
  withdrawal_by     text
);
CREATE UNIQUE INDEX research_consent_active ON research_consents (org_id, participant_id, purpose) WHERE withdrawn_at IS NULL;

-- A withdrawal from research is recorded even if the person never consented, so no new link can be made.
CREATE TABLE research_withdrawals (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES orgs(id),
  participant_id  text NOT NULL REFERENCES participants(id),
  method          text NOT NULL,
  recorded_by     text NOT NULL,
  at              timestamptz NOT NULL
);
CREATE INDEX research_withdrawals_p ON research_withdrawals (org_id, participant_id);

ALTER TABLE survey_invites ADD COLUMN revoked_at bigint;
ALTER TABLE survey_invites ADD COLUMN notice_version text;
-- Links created before consent checks existed are cancelled.
UPDATE survey_invites SET revoked_at = 0 WHERE used_at IS NULL;
CREATE UNIQUE INDEX survey_invite_one_active ON survey_invites (org_id, participant_id, survey_id) WHERE used_at IS NULL AND revoked_at IS NULL;
ALTER TABLE survey_responses ADD COLUMN consent_id text REFERENCES research_consents(id);
CREATE UNIQUE INDEX survey_one_response ON survey_responses (org_id, participant_id, survey_id);
