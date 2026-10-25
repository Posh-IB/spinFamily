-- Additive household profile slots, without new sign-in credentials for children.
ALTER TABLE household_members ADD COLUMN IF NOT EXISTS profile_slot TEXT;
ALTER TABLE household_members ADD COLUMN IF NOT EXISTS skin_tone SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE household_members ADD CONSTRAINT family_profile_slot_allowed CHECK
 (profile_slot IS NULL OR profile_slot IN ('parent1','parent2','child1','child2','child3','child4','adult1'));
ALTER TABLE household_members ADD CONSTRAINT family_profile_skin_tone CHECK (skin_tone BETWEEN 0 AND 5);
CREATE UNIQUE INDEX IF NOT EXISTS household_members_one_per_slot
 ON household_members(household_id,profile_slot) WHERE profile_slot IS NOT NULL;
