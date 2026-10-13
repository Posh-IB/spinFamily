-- SPINFAMILY-SCHEMA-001: isolated preview baseline.
-- Derived from docs/database-schema-v0.1.sql; add required custom activities and billing linkage.
-- PREVIEW ONLY until founder approves production release. Netlify applies this on preview deployment.
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
 provider_price_id TEXT,
 stripe_livemode BOOLEAN NOT NULL DEFAULT false,
 status TEXT NOT NULL DEFAULT 'inactive'
   CHECK (status IN ('inactive','trialing','active','past_due','unpaid','canceled','incomplete','incomplete_expired','paused')),
 current_period_end TIMESTAMPTZ,
 last_provider_event_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE billing_checkout_sessions (
 provider_session_id TEXT PRIMARY KEY,
 household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
 provider_customer_id TEXT NOT NULL,
 provider_price_id TEXT NOT NULL,
 stripe_livemode BOOLEAN NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX checkout_sessions_household_idx ON billing_checkout_sessions(household_id);
CREATE TABLE billing_events (
 provider_event_id TEXT PRIMARY KEY,
 event_type TEXT NOT NULL,
 provider_created_at TIMESTAMPTZ NOT NULL,
 outcome TEXT NOT NULL CHECK (outcome IN ('applied','ignored_unlinked','ignored_conflict','ignored_stale','ignored_irrelevant')),
 processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE custom_activities (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
 name TEXT NOT NULL CHECK(char_length(name) BETWEEN 1 AND 80),
 category TEXT NOT NULL CHECK(category IN ('chore','outdoor','family','selfcare')),
 duration_minutes INTEGER NOT NULL DEFAULT 20 CHECK(duration_minutes BETWEEN 1 AND 120),
 moderation_policy_version TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX custom_activities_household_created_idx ON custom_activities(household_id, created_at DESC);
