-- Migration C: Add nullable FK columns to dependent tables
-- Part of the Catalog Framework master plan (dev_task 8e25106f, Phase 1)
-- Spec: sysdoc 'ops-2026-05-09-catalog-framework-spec'
--
-- These columns are NULLABLE now. Phase 2 backfills them, then Phase 2 end
-- enforces NOT NULL and drops the old text columns.
--
-- Tables touched:
--   service_deliveries  — new: service_type_entry_id UUID FK catalog_entries
--   client_partners     — new: agreed_service_entry_ids JSONB (array of UUIDs)
--   accounts            — new: services_bundle_entry_ids JSONB (array of UUIDs)
--   offers              — new: bundled_pipeline_entry_ids JSONB (array of UUIDs)
--   pipeline_stages     — new: service_type_entry_id UUID FK catalog_entries
--
-- Old text columns (service_type, agreed_services, services_bundle,
-- bundled_pipelines, pipeline_stages.service_type) are KEPT for now.
-- They will be dropped after Phase 2 backfill confirms all data migrated.
--
-- Apply to SANDBOX first: node scripts/apply-migration.js scripts/migrations/20260509-catalog-fk-columns.sql

-- ─────────────────────────────────────────────────────────────────────────
-- 1. service_deliveries.service_type_entry_id
-- The main SD table — currently uses service_type TEXT (free-form).
-- New FK column points to catalog_entries.id.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE service_deliveries
  ADD COLUMN IF NOT EXISTS service_type_entry_id UUID REFERENCES catalog_entries(id);

COMMENT ON COLUMN service_deliveries.service_type_entry_id IS 'FK to catalog_entries — replaces free-text service_type. Nullable until Phase 2 backfill.';

CREATE INDEX IF NOT EXISTS idx_sd_service_type_entry_id
  ON service_deliveries (service_type_entry_id) WHERE service_type_entry_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. client_partners.agreed_service_entry_ids
-- Currently uses agreed_services TEXT[] with inconsistent slugs.
-- New column stores JSONB array of catalog_entries UUIDs.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE client_partners
  ADD COLUMN IF NOT EXISTS agreed_service_entry_ids JSONB DEFAULT '[]';

COMMENT ON COLUMN client_partners.agreed_service_entry_ids IS 'JSONB array of catalog_entries UUIDs — replaces agreed_services TEXT[]. Nullable/empty until Phase 2 backfill.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. accounts.services_bundle_entry_ids
-- Currently uses services_bundle TEXT[] with heavily drifted values (CF-3).
-- New column stores JSONB array of catalog_entries UUIDs.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS services_bundle_entry_ids JSONB DEFAULT '[]';

COMMENT ON COLUMN accounts.services_bundle_entry_ids IS 'JSONB array of catalog_entries UUIDs — replaces services_bundle TEXT[]. Nullable/empty until Phase 2 backfill.';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. offers.bundled_pipeline_entry_ids
-- Currently uses bundled_pipelines TEXT[] with minor drift (EIN vs EIN Application).
-- New column stores JSONB array of catalog_entries UUIDs.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS bundled_pipeline_entry_ids JSONB DEFAULT '[]';

COMMENT ON COLUMN offers.bundled_pipeline_entry_ids IS 'JSONB array of catalog_entries UUIDs — replaces bundled_pipelines TEXT[]. Nullable/empty until Phase 2 backfill.';

-- ─────────────────────────────────────────────────────────────────────────
-- 5. pipeline_stages.service_type_entry_id
-- Currently uses service_type TEXT with 3 non-canonical values (CF atlas).
-- New FK column points to catalog_entries.id.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS service_type_entry_id UUID REFERENCES catalog_entries(id);

COMMENT ON COLUMN pipeline_stages.service_type_entry_id IS 'FK to catalog_entries — replaces free-text service_type. Nullable until Phase 2 backfill.';

CREATE INDEX IF NOT EXISTS idx_pipeline_stages_service_type_entry_id
  ON pipeline_stages (service_type_entry_id) WHERE service_type_entry_id IS NOT NULL;
