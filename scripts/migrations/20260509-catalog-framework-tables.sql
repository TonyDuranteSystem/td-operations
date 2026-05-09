-- Migration A: Catalog Framework — 4 foundation tables
-- Part of the Catalog Framework master plan (dev_task 8e25106f, Phase 1)
-- Spec: sysdoc 'ops-2026-05-09-catalog-framework-spec'
--
-- These tables are GENERIC infrastructure — not Services-specific.
-- Services is the first user; Pipeline Stages, Document Types, etc. follow.
--
-- Apply to SANDBOX first: node scripts/apply-migration.js scripts/migrations/20260509-catalog-framework-tables.sql
-- Promote to production only after Antonio's explicit approval.

-- ─────────────────────────────────────────────────────────────────────────
-- Table 1: catalog_definitions
-- The list of catalogs. One row per business concept.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catalog_definitions (
  id                        TEXT PRIMARY KEY,
  display_name              TEXT NOT NULL,
  display_name_translations JSONB DEFAULT '{}',
  description               TEXT,
  admin_can_add_rows        BOOLEAN DEFAULT true,
  tags_schema               JSONB,
  created_at                TIMESTAMPTZ DEFAULT now(),
  updated_at                TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE catalog_definitions IS 'Registry of all business-concept catalogs (services, pipeline_stages, doc_types, etc.)';
COMMENT ON COLUMN catalog_definitions.id IS 'Stable identifier — e.g. services, pipeline_stages, document_types';
COMMENT ON COLUMN catalog_definitions.tags_schema IS 'JSON schema defining which tags are valid for entries in this catalog';

-- ─────────────────────────────────────────────────────────────────────────
-- Table 2: catalog_entries
-- Rows of every catalog. The actual values that other tables reference via FK.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catalog_entries (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id                  TEXT NOT NULL REFERENCES catalog_definitions(id),
  slug                        TEXT NOT NULL,
  display_name                TEXT NOT NULL,
  display_name_translations   JSONB DEFAULT '{}',
  description                 TEXT,
  description_translations    JSONB DEFAULT '{}',
  status                      TEXT NOT NULL CHECK (status IN ('active', 'deprecated', 'exception_only')),
  tags                        JSONB DEFAULT '[]',
  capabilities                JSONB DEFAULT '{}',
  metadata                    JSONB DEFAULT '{}',
  created_at                  TIMESTAMPTZ DEFAULT now(),
  updated_at                  TIMESTAMPTZ DEFAULT now(),
  created_by                  UUID,
  updated_by                  UUID,
  UNIQUE (catalog_id, slug)
);

COMMENT ON TABLE catalog_entries IS 'All entries across all catalogs — the canonical values that FK columns reference';
COMMENT ON COLUMN catalog_entries.slug IS 'Stable snake_case identifier. Never changes once created.';
COMMENT ON COLUMN catalog_entries.status IS 'active = normal use. deprecated = kept for history, blocked for new writes. exception_only = Custom/Pending Review escape valves.';
COMMENT ON COLUMN catalog_entries.tags IS 'Behavioral tags — e.g. ["service","sellable","auto_bundled_with_management"]';
COMMENT ON COLUMN catalog_entries.capabilities IS 'Free-form behavior flags for future extensions';
COMMENT ON COLUMN catalog_entries.metadata IS 'Free-form extension data';

CREATE INDEX IF NOT EXISTS idx_catalog_entries_catalog_status
  ON catalog_entries (catalog_id, status);

-- ─────────────────────────────────────────────────────────────────────────
-- Table 3: catalog_decision_log
-- Audit trail — every catalog change with plain-English reasoning.
-- WHO + WHEN + WHY for every mutation.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catalog_decision_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_entry_id  UUID REFERENCES catalog_entries(id),
  catalog_id        TEXT NOT NULL REFERENCES catalog_definitions(id),
  action            TEXT NOT NULL CHECK (action IN (
                      'added', 'renamed', 'deprecated', 'restored',
                      'tagged', 'metadata_changed',
                      'translation_added', 'translation_changed'
                    )),
  actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('chat', 'ui', 'migration', 'admin_api')),
  actor_user_id     UUID,
  reason            TEXT NOT NULL,
  before_state      JSONB,
  after_state       JSONB,
  created_at        TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE catalog_decision_log IS 'Immutable audit trail — every catalog change with plain-English reasoning';
COMMENT ON COLUMN catalog_decision_log.catalog_entry_id IS 'NULL for catalog-level changes (e.g. new catalog created)';
COMMENT ON COLUMN catalog_decision_log.reason IS 'Plain English — captured by Claude during chat edits or by admin in UI';

CREATE INDEX IF NOT EXISTS idx_catalog_decision_log_entry
  ON catalog_decision_log (catalog_entry_id) WHERE catalog_entry_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_catalog_decision_log_catalog
  ON catalog_decision_log (catalog_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- Table 4: catalog_pending_review
-- Queue for unrecognized values from external sources (webhooks, forms).
-- Values land here instead of being silently accepted or rejected.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catalog_pending_review (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id            TEXT NOT NULL REFERENCES catalog_definitions(id),
  submitted_value       TEXT NOT NULL,
  source                TEXT NOT NULL CHECK (source IN (
                          'whop_webhook', 'stripe_webhook', 'plaid_webhook',
                          'manual_form', 'admin_input', 'mcp_tool'
                        )),
  source_metadata       JSONB DEFAULT '{}',
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                          'pending', 'approved_added', 'approved_aliased', 'rejected'
                        )),
  resolved_at           TIMESTAMPTZ,
  resolved_by           UUID,
  resolved_to_entry_id  UUID REFERENCES catalog_entries(id),
  created_at            TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE catalog_pending_review IS 'Anti-corruption queue — unrecognized values from external sources await human decision';
COMMENT ON COLUMN catalog_pending_review.submitted_value IS 'The raw string as received from the external source';
COMMENT ON COLUMN catalog_pending_review.source_metadata IS 'Full payload from the source for reconstruction if needed';

CREATE INDEX IF NOT EXISTS idx_catalog_pending_review_status
  ON catalog_pending_review (catalog_id, status) WHERE status = 'pending';
