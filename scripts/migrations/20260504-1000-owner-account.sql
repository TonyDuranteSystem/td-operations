-- Migration: add is_internal flag to accounts + insert Tony Durante LLC owner account
-- Applied to sandbox first (R105), then production after Antonio approval.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO accounts (id, company_name, is_internal, is_test)
VALUES ('00000000-0000-0000-0000-000000000001', 'Tony Durante LLC', TRUE, FALSE)
ON CONFLICT (id) DO UPDATE SET company_name = 'Tony Durante LLC', is_internal = TRUE;
