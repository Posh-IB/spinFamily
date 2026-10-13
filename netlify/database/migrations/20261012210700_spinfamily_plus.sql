-- SpinFamily Plus isolated preview candidate. Deploy applies automatically; do not merge into main.
CREATE TABLE IF NOT EXISTS account_profiles (
 identity_subject TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS households (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_subject TEXT NOT NULL UNIQUE REFERENCES account_profiles(identity_subject) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS subscriptions (
 household_id UUID PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
 provider_customer_id TEXT UNIQUE,
 provider_subscription_id TEXT UNIQUE,
 status TEXT NOT NULL DEFAULT 'inactive',
 current_period_end TIMESTAMPTZ,
 last_provider_event_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS custom_activities (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
 name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
 category TEXT NOT NULL CHECK (category IN ('chore','outdoor','family','selfcare')),
 duration_minutes INTEGER NOT NULL DEFAULT 20 CHECK (duration_minutes BETWEEN 1 AND 120),
 moderation_policy_version TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS custom_activities_household_idx ON custom_activities(household_id,created_at DESC);
CREATE TABLE IF NOT EXISTS stripe_checkout_claims (
 reference UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT (now()+interval '30 minutes'),
 consumed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS stripe_processed_events (
 event_id TEXT PRIMARY KEY,
 event_type TEXT NOT NULL,
 event_created_at TIMESTAMPTZ NOT NULL,
 processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
