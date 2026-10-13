-- Compatible expansion of prior 20261012210700_spinfamily_plus.sql.
ALTER TABLE account_profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE households ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT 'My household';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'stripe';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_price_id TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_livemode BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE stripe_processed_events ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'ignored_irrelevant';
CREATE TABLE IF NOT EXISTS household_members (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
 display_alias TEXT NOT NULL CHECK (char_length(display_alias) BETWEEN 1 AND 80),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS household_members_household_idx ON household_members(household_id);
CREATE TABLE IF NOT EXISTS saved_plans (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
 plan_data JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(pg_column_size(plan_data) <= 65536)
);
CREATE INDEX IF NOT EXISTS saved_plans_household_created_idx ON saved_plans(household_id,created_at DESC);
CREATE TABLE IF NOT EXISTS billing_checkout_sessions (
 provider_session_id TEXT PRIMARY KEY,
 household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
 provider_customer_id TEXT NOT NULL,
 provider_price_id TEXT NOT NULL,
 stripe_livemode BOOLEAN NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS checkout_sessions_household_idx ON billing_checkout_sessions(household_id);
