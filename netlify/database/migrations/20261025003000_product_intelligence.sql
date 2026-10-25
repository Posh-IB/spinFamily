-- Consent-based first-party interaction metrics for authenticated family accounts.
-- Deliberately no email, names, activity text, IP address or payment payload.
CREATE TABLE IF NOT EXISTS product_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  session_id UUID NOT NULL,
  event_id UUID NOT NULL,
  event_name TEXT NOT NULL CHECK (event_name IN (
    'session_started','screen_viewed','screen_exited','wheel_spun','plan_viewed',
    'plan_accepted','plan_completed','custom_activity_created','upgrade_clicked',
    'checkout_started','checkout_canceled')),
  screen TEXT NOT NULL CHECK (screen IN ('home','activities','family','guide','more','checkout')),
  active_ms INTEGER CHECK (active_ms BETWEEN 0 AND 300000),
  spins_before_plan SMALLINT CHECK (spins_before_plan BETWEEN 0 AND 255),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (household_id, session_id, event_id)
);
CREATE INDEX IF NOT EXISTS product_events_household_received_idx
 ON product_events(household_id,received_at DESC);
CREATE INDEX IF NOT EXISTS product_events_retention_idx
 ON product_events(received_at);