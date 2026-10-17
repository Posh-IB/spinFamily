-- Reuse existing saved_plans rather than creating a second history authority.
-- Canonical private WP2 semantics: explicit accept then explicit caregiver completion.
ALTER TABLE households ADD COLUMN IF NOT EXISTS history_timezone TEXT;
ALTER TABLE saved_plans ADD COLUMN IF NOT EXISTS client_plan_id UUID;
ALTER TABLE saved_plans ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE saved_plans ADD COLUMN IF NOT EXISTS completion_source TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS saved_plans_household_client_plan_idx
  ON saved_plans(household_id,client_plan_id)
  WHERE client_plan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS saved_plans_household_completed_idx
  ON saved_plans(household_id,completed_at DESC)
  WHERE completed_at IS NOT NULL;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='saved_plans_completion_valid') THEN
  ALTER TABLE saved_plans ADD CONSTRAINT saved_plans_completion_valid CHECK
   ((completed_at IS NULL AND completion_source IS NULL) OR
    (completed_at IS NOT NULL AND completion_source='explicit_caregiver'
     AND completed_at>=created_at));
 END IF;
END $$;
