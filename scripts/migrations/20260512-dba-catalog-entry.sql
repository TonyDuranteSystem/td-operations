-- Account fields Phase 1, Part 3: register DBA in the Services catalog
-- Plan: ops-2026-05-12-account-fields-plan
--
-- Adds the DBA (Doing Business As) entry to catalog_entries so the pipeline
-- stages and per-SD detail rows added in companion migrations can resolve
-- back to a canonical catalog slug.
--
-- Slug:         dba (immutable per Catalog Framework)
-- Display name: DBA Registration
-- Tags:         service, sd, sellable — mirrors EIN/ITIN (standalone sellable
--               service that also creates an operational SD track).
-- Status:       active
--
-- Idempotent via ON CONFLICT on (catalog_id, slug) — re-runs are safe.
-- Logs to catalog_decision_log only on first insert (NOT EXISTS guard).
--
-- Apply to SANDBOX first:
--   node scripts/apply-migration.js scripts/migrations/20260512-dba-catalog-entry.sql

INSERT INTO catalog_entries (
  catalog_id,
  slug,
  display_name,
  display_name_translations,
  description,
  status,
  tags
)
VALUES (
  'services',
  'dba',
  'DBA Registration',
  '{"it": "Registrazione DBA"}',
  'Doing Business As (fictitious name / trade name) registration with the state. A standalone sellable service that creates an SD track. One client can have multiple DBA SDs (one per trade name / per state).',
  'active',
  '["service","sd","sellable"]'::jsonb
)
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- Decision log entry — only on first insert (idempotency guard)
INSERT INTO catalog_decision_log (
  catalog_entry_id,
  catalog_id,
  action,
  actor_kind,
  reason,
  after_state
)
SELECT
  ce.id,
  ce.catalog_id,
  'added',
  'migration',
  'Phase 1 of account fields plan (ops-2026-05-12-account-fields-plan): register DBA as a sellable Service + SD type. Companion migrations seed pipeline_stages and create dba_details table.',
  jsonb_build_object(
    'slug',          ce.slug,
    'display_name',  ce.display_name,
    'status',        ce.status,
    'tags',          ce.tags
  )
FROM catalog_entries ce
WHERE ce.catalog_id = 'services'
  AND ce.slug = 'dba'
  AND NOT EXISTS (
    SELECT 1 FROM catalog_decision_log cdl
    WHERE cdl.catalog_entry_id = ce.id
      AND cdl.action = 'added'
      AND cdl.actor_kind = 'migration'
  );
