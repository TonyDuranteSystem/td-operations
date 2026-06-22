-- Add portal_roles array to contacts (additive, non-breaking)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS portal_roles text[] DEFAULT NULL;

-- Backfill from existing portal_role: if portal_role is set and portal_roles is NULL,
-- populate portal_roles with [portal_role]. One-time migration.
UPDATE contacts
SET portal_roles = ARRAY[portal_role]
WHERE portal_role IS NOT NULL
  AND portal_roles IS NULL;

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_contacts_portal_roles ON contacts USING gin(portal_roles);
