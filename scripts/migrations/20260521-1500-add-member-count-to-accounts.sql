-- Add member_count to accounts table
-- Stores the official number of members for Multi Member LLCs.
-- Source of truth priority: (1) SS-4 member_count when SS-4 exists in system,
-- (2) manually set by staff in CRM for legacy/external-filed clients.
-- Used by: OA generation pre-flight validation, member info form, members card.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS member_count INTEGER;

-- Back-fill from ss4_applications where available
UPDATE accounts a
SET member_count = s.member_count
FROM ss4_applications s
WHERE s.account_id = a.id
  AND s.member_count IS NOT NULL
  AND a.member_count IS NULL;
