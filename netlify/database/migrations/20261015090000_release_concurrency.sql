-- Additive release hardening: do not alter previously deployed migrations.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS verified_payment BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS terminal BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE billing_checkout_sessions ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;
CREATE TABLE billing_checkout_attempts (
 household_id UUID PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
 attempt_id UUID NOT NULL DEFAULT gen_random_uuid(),
 price_id TEXT NOT NULL,
 provider_session_id TEXT UNIQUE,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT (now()+interval '1 hour'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Serialize count and insert even when requests use different connections.
CREATE FUNCTION enforce_custom_activity_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM households WHERE id=NEW.household_id FOR UPDATE;
 IF (SELECT count(*) FROM custom_activities WHERE household_id=NEW.household_id)>=20 THEN
  RAISE EXCEPTION 'activity_limit' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER custom_activity_limit BEFORE INSERT ON custom_activities
 FOR EACH ROW EXECUTE FUNCTION enforce_custom_activity_limit();
