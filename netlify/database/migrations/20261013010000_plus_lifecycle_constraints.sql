-- Additive correction. Keep original migration immutable until hosted history is verified.
ALTER TABLE subscriptions ADD COLUMN price_id TEXT;
ALTER TABLE subscriptions ADD COLUMN verified_payment BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN terminal BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD CONSTRAINT subscription_status CHECK(status IN ('inactive','incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused'));
ALTER TABLE subscriptions ADD CONSTRAINT provider_pair CHECK ((provider_customer_id IS NULL) = (provider_subscription_id IS NULL));
ALTER TABLE stripe_checkout_claims ADD COLUMN plan TEXT CHECK(plan IN ('monthly','annual'));
ALTER TABLE stripe_checkout_claims ADD COLUMN price_id TEXT;
ALTER TABLE stripe_checkout_claims ADD COLUMN payment_link_id TEXT;
CREATE INDEX checkout_claim_household_pending ON stripe_checkout_claims(household_id,expires_at) WHERE consumed_at IS NULL;
