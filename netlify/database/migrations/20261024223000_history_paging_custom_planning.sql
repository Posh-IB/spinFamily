-- Additive candidate migration; existing custom activities require explicit planning details.
CREATE INDEX IF NOT EXISTS saved_plans_household_page_idx ON saved_plans(household_id,created_at DESC,id DESC) WHERE client_plan_id IS NOT NULL;
ALTER TABLE custom_activities ADD COLUMN IF NOT EXISTS planning_metadata JSONB;
ALTER TABLE custom_activities ADD CONSTRAINT custom_activities_planning_object CHECK (planning_metadata IS NULL OR jsonb_typeof(planning_metadata)='object');
