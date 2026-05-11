-- Add member_structure field to accounts
-- Separates "how many members" from entity_type (the tax classification).
-- Allows C-Corp Elected LLCs to be marked single or multi member
-- without proliferating entity_type values.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS member_structure TEXT
    CHECK (member_structure IN ('single_member', 'multi_member'));

-- Backfill from existing entity_type
UPDATE accounts SET member_structure = 'single_member' WHERE entity_type = 'Single Member LLC' AND member_structure IS NULL;
UPDATE accounts SET member_structure = 'multi_member'  WHERE entity_type = 'Multi Member LLC'  AND member_structure IS NULL;
-- C-Corp Elected stays NULL — must be classified manually per account
