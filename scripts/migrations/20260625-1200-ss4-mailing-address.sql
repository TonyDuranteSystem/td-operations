-- Add mailing address columns to ss4_applications so the live PDF renderer
-- can use the account's actual mailing address (not a hardcoded constant).
-- Both columns are nullable; the renderer falls back to the TD Park Blvd address
-- for legacy rows created before this migration.

ALTER TABLE ss4_applications
  ADD COLUMN IF NOT EXISTS mailing_street         VARCHAR,
  ADD COLUMN IF NOT EXISTS mailing_city_state_zip VARCHAR;
