-- SpinFamily Pilot Operations (SF-PILOT-OPS-001): foundation schema.
-- Multi-company from the start: every record belongs to an organization (org_id),
-- and people get a role per organization through memberships.

CREATE TABLE orgs (
  id          text PRIMARY KEY,                -- e.g. 'spinfamily'
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE members (
  id                   text PRIMARY KEY,
  email                text NOT NULL UNIQUE CHECK (email = lower(email)),
  name                 text NOT NULL,
  totp_secret          text,
  totp_enabled         boolean NOT NULL DEFAULT false,
  totp_last_step       bigint NOT NULL DEFAULT -1,
  totp_pending         jsonb,
  link_requests        jsonb NOT NULL DEFAULT '[]',
  sessions_valid_after bigint NOT NULL DEFAULT 0,
  last_sign_in_at      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  org_id      text NOT NULL REFERENCES orgs(id),
  member_id   text NOT NULL REFERENCES members(id),
  role        text NOT NULL CHECK (role IN ('founder', 'coordinator')),
  title       text NOT NULL DEFAULT '',
  status      text NOT NULL CHECK (status IN ('invited', 'active', 'revoked')),
  invited_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, member_id)
);
CREATE UNIQUE INDEX one_founder_per_org ON memberships (org_id) WHERE role = 'founder';

CREATE TABLE login_links (
  token_hash  text PRIMARY KEY,
  member_id   text NOT NULL REFERENCES members(id),
  org_id      text NOT NULL REFERENCES orgs(id),
  expires_at  bigint NOT NULL,
  used_at     bigint
);

CREATE TABLE sessions (
  sid_hash      text PRIMARY KEY,
  member_id     text NOT NULL REFERENCES members(id),
  org_id        text NOT NULL REFERENCES orgs(id),
  created_at    bigint NOT NULL,
  last_seen     bigint NOT NULL,
  expires_at    bigint NOT NULL,
  mfa           text NOT NULL CHECK (mfa IN ('none', 'pending', 'verified')),
  mfa_failures  int NOT NULL DEFAULT 0,
  via           text NOT NULL
);
CREATE INDEX sessions_member ON sessions (member_id);

CREATE TABLE participants (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES orgs(id),
  first_name        text NOT NULL,
  email             text NOT NULL DEFAULT '',
  cohort            text NOT NULL,
  enrollment        text NOT NULL,
  account           text NOT NULL,
  engagement        text NOT NULL,
  communication     text NOT NULL,
  technical_source  text,                      -- from the pilot form; never edited by hand
  heard_from        text,                      -- what the parent said on the form (self-reported)
  reported_source   text NOT NULL DEFAULT 'unknown', -- what the team reports (field report)
  -- Account, engagement and email states are 'reported' unless the founder verified them against a source.
  account_verified        boolean NOT NULL DEFAULT false,
  engagement_verified     boolean NOT NULL DEFAULT false,
  communication_verified  boolean NOT NULL DEFAULT false,
  version           int NOT NULL DEFAULT 1,     -- optimistic concurrency: every update must name the version it read
  assigned_to       text REFERENCES members(id),
  is_test           boolean,                   -- null = not reviewed yet
  origin            text NOT NULL,
  intake            jsonb,
  notes             text NOT NULL DEFAULT '',
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL
);
CREATE UNIQUE INDEX participants_email ON participants (org_id, email) WHERE email <> '';
CREATE INDEX participants_assigned ON participants (org_id, assigned_to);

CREATE TABLE participant_history (
  id              bigserial PRIMARY KEY,
  org_id          text NOT NULL REFERENCES orgs(id),
  participant_id  text NOT NULL REFERENCES participants(id),
  at              timestamptz NOT NULL,
  actor           text NOT NULL,
  changes         jsonb NOT NULL
);
CREATE INDEX participant_history_p ON participant_history (participant_id, id);

-- Every pilot-form event as received, with provenance. One row per distinct submission.
CREATE TABLE pilot_intake_records (
  id                    text PRIMARY KEY,
  org_id                text NOT NULL REFERENCES orgs(id),
  source_submission_id  text,                  -- Netlify's submission id when the event carries one; never invented
  payload_hash          text NOT NULL,         -- SHA-256 of the normalized submission, for duplicate deliveries
  source_timestamp      timestamptz,           -- when Netlify says it was submitted, if provided
  received_at           timestamptz NOT NULL,
  provenance            text NOT NULL CHECK (provenance IN ('event_with_id', 'event_without_id', 'founder_import')),
  consent               jsonb NOT NULL,        -- { purpose, value, version }
  technical_source      text,
  heard_from            text,
  participant_id        text REFERENCES participants(id),
  outcome               text NOT NULL CHECK (outcome IN ('created', 'linked_existing', 'promoted_prospect')),
  UNIQUE (org_id, payload_hash)
);
CREATE UNIQUE INDEX pilot_intake_submission ON pilot_intake_records (org_id, source_submission_id) WHERE source_submission_id IS NOT NULL;

CREATE TABLE followups (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES orgs(id),
  title         text NOT NULL,
  subject_type  text NOT NULL,
  subject_id    text,
  due_date      date,
  assigned_to   text NOT NULL REFERENCES members(id),
  status        text NOT NULL,
  outcome       text NOT NULL DEFAULT '',
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  completed_at  timestamptz
);

CREATE TABLE outreach (
  id                     text PRIMARY KEY,
  org_id                 text NOT NULL REFERENCES orgs(id),
  date                   date NOT NULL,
  channel                text NOT NULL,
  place                  text NOT NULL,
  approached             int,                  -- null = unknown, never 0 by default
  demos                  int,
  reported_signups       int,
  follow_up_commitments  text NOT NULL DEFAULT '',
  observations           text NOT NULL DEFAULT '',
  blockers               text NOT NULL DEFAULT '',
  evidence               text NOT NULL DEFAULT 'field_report',
  recorded_by            text NOT NULL,
  created_at             timestamptz NOT NULL
);

CREATE TABLE relationships (
  id                text PRIMARY KEY,
  org_id            text NOT NULL REFERENCES orgs(id),
  contact_name      text NOT NULL,
  organization      text NOT NULL,
  office            text NOT NULL DEFAULT '',
  stage             text NOT NULL,
  next_action       text NOT NULL DEFAULT '',
  next_action_date  date,
  owner             text,
  notes             text NOT NULL DEFAULT '',
  offer_approved    boolean NOT NULL DEFAULT false,
  agreement_status  text NOT NULL DEFAULT 'none',
  version           int NOT NULL DEFAULT 1,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL
);

CREATE TABLE relationship_log (
  id               bigserial PRIMARY KEY,
  org_id           text NOT NULL REFERENCES orgs(id),
  relationship_id  text NOT NULL REFERENCES relationships(id),
  at               timestamptz NOT NULL,
  by_member        text NOT NULL,
  kind             text NOT NULL,
  summary          text NOT NULL
);

CREATE TABLE documents (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES orgs(id),
  kind           text NOT NULL CHECK (kind IN ('link', 'file')),
  title          text NOT NULL,
  url            text,
  intended_use   text NOT NULL DEFAULT '',
  category       text NOT NULL DEFAULT 'other',
  approval       text NOT NULL,
  audience       jsonb NOT NULL DEFAULT '"team"',
  file_name      text,
  content_type   text,
  size           int,
  file_key       text,                         -- bytes live in Netlify Blobs under this key
  uploaded_by    text,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL
);

CREATE TABLE approvals (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES orgs(id),
  item_type      text NOT NULL CHECK (item_type IN ('document', 'content_post', 'message', 'offer', 'survey')),
  item_id        text,
  title          text NOT NULL,
  summary        text NOT NULL DEFAULT '',
  payload        jsonb NOT NULL DEFAULT '{}',
  submitted_by   text NOT NULL REFERENCES members(id),
  submitted_at   timestamptz NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending', 'approved', 'changes_requested', 'withdrawn')),
  decided_by     text,
  decided_at     timestamptz,
  decision_note  text NOT NULL DEFAULT ''
);
CREATE INDEX approvals_pending ON approvals (org_id, status);

CREATE TABLE content_posts (
  id                 text PRIMARY KEY,
  org_id             text NOT NULL REFERENCES orgs(id),
  channel            text NOT NULL,
  planned_date       date,
  caption            text NOT NULL DEFAULT '',
  ref_link           text NOT NULL DEFAULT '',
  asset_document_id  text REFERENCES documents(id),
  status             text NOT NULL,
  published_url      text NOT NULL DEFAULT '',
  notes              text NOT NULL DEFAULT '',
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL
);

CREATE TABLE research_cohorts (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES orgs(id),
  name          text NOT NULL,
  partner       text NOT NULL DEFAULT '',
  description   text NOT NULL DEFAULT '',
  protocol      text NOT NULL DEFAULT '',
  planned_size  int,
  deadline      date,
  status        text NOT NULL,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);

CREATE TABLE research_enrollments (
  org_id          text NOT NULL REFERENCES orgs(id),
  cohort_id       text NOT NULL REFERENCES research_cohorts(id),
  participant_id  text NOT NULL REFERENCES participants(id),
  status          text NOT NULL,
  consent_at      timestamptz,
  created_at      timestamptz NOT NULL,
  PRIMARY KEY (cohort_id, participant_id)
);

CREATE TABLE research_sessions (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES orgs(id),
  cohort_id       text NOT NULL REFERENCES research_cohorts(id),
  participant_id  text NOT NULL REFERENCES participants(id),
  kind            text NOT NULL,
  scheduled_for   date,
  completed_at    timestamptz,
  observations    text NOT NULL DEFAULT '',
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL
);

CREATE TABLE survey_definitions (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES orgs(id),
  title        text NOT NULL,
  version      int NOT NULL,
  status       text NOT NULL CHECK (status IN ('draft', 'approved', 'retired')),
  intro        text NOT NULL DEFAULT '',
  questions    jsonb NOT NULL,
  approved_by  text,
  approved_at  timestamptz,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL,
  UNIQUE (org_id, title, version)
);

CREATE TABLE survey_invites (
  token_hash      text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES orgs(id),
  survey_id       text NOT NULL REFERENCES survey_definitions(id),
  participant_id  text NOT NULL REFERENCES participants(id),
  cohort_id       text REFERENCES research_cohorts(id),
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL,
  expires_at      bigint NOT NULL,
  used_at         bigint
);

CREATE TABLE survey_responses (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES orgs(id),
  survey_id       text NOT NULL REFERENCES survey_definitions(id),
  survey_version  int NOT NULL,
  participant_id  text NOT NULL REFERENCES participants(id),
  cohort_id       text REFERENCES research_cohorts(id),
  answers         jsonb NOT NULL,
  submitted_at    timestamptz NOT NULL
);

CREATE TABLE audit_events (
  id      bigserial PRIMARY KEY,
  org_id  text,
  at      timestamptz NOT NULL,
  actor   text NOT NULL,
  action  text NOT NULL,
  target  text,
  extra   jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE org_meta (
  org_id  text NOT NULL REFERENCES orgs(id),
  key     text NOT NULL,
  value   jsonb NOT NULL,
  PRIMARY KEY (org_id, key)
);

-- History and audit records can be added but never changed or removed.
CREATE FUNCTION ops_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table: % is not allowed on %', TG_OP, TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER participant_history_append_only BEFORE UPDATE OR DELETE ON participant_history FOR EACH ROW EXECUTE FUNCTION ops_append_only();
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION ops_append_only();
CREATE TRIGGER relationship_log_append_only BEFORE UPDATE OR DELETE ON relationship_log FOR EACH ROW EXECUTE FUNCTION ops_append_only();
CREATE TRIGGER pilot_intake_append_only BEFORE UPDATE OR DELETE ON pilot_intake_records FOR EACH ROW EXECUTE FUNCTION ops_append_only();
CREATE TRIGGER survey_responses_append_only BEFORE UPDATE OR DELETE ON survey_responses FOR EACH ROW EXECUTE FUNCTION ops_append_only();

INSERT INTO orgs (id, name) VALUES ('spinfamily', 'SpinFamily');
