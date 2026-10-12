-- SpinFamily v0.1 PROPOSED schema, for review and migration preparation only.
-- This file is deliberately under docs/, NOT netlify/database/migrations/.
-- Do not execute on production or preview until branch data isolation is confirmed.
CREATE TABLE account_profiles (
 identity_subject TEXT PRIMARY KEY,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE households (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_subject TEXT NOT NULL UNIQUE REFERENCES account_profiles(identity_subject) ON DELETE CASCADE,
 display_name TEXT NOT NULL DEFAULT 'My household',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE household_members (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
 display_alias TEXT NOT NULL CHECK (char_length(display_alias) BETWEEN 1 AND 80),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX household_members_household_idx ON household_members(household_id);
CREATE TABLE saved_plans (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
 plan_data JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK (pg_column_size(plan_data) <= 65536)
);
CREATE INDEX saved_plans_household_created_idx ON saved_plans(household_id, created_at DESC);
CREATE TABLE subscriptions (
 household_id UUID PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
 provider TEXT NOT NULL DEFAULT 'stripe' CHECK (provider = 'stripe'),
 provider_customer_id TEXT UNIQUE,
 provider_subscription_id TEXT UNIQUE,
 status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive','trialing','active','past_due','unpaid','canceled','incomplete','incomplete_expired','paused')),
 current_period_end TIMESTAMPTZ,
 last_provider_event_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE billing_events (
 provider_event_id TEXT PRIMARY KEY,
 event_type TEXT NOT NULL,
 provider_created_at TIMESTAMPTZ NOT NULL,
 processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
