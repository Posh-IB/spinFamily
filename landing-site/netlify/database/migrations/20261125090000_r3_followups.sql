-- SF-PILOT-OPS-001 third review (6052378857) follow-ups. New migration; earlier ones are never edited.

-- Outbox delivery states. An email whose send started but whose outcome was never recorded is
-- 'uncertain' and is NOT retried automatically (it may already have been delivered).
ALTER TABLE notifications_outbox ADD COLUMN status text NOT NULL DEFAULT 'queued'
  CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'uncertain'));
UPDATE notifications_outbox SET status = CASE WHEN sent_at IS NOT NULL THEN 'sent' WHEN attempts > 0 THEN 'failed' ELSE 'queued' END;
CREATE INDEX notifications_outbox_status ON notifications_outbox (org_id, status, created_at);
