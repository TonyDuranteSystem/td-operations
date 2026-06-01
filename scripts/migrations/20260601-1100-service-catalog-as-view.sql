-- =====================================================================
-- Migration: service_catalog → VIEW over catalog_entries
-- =====================================================================
-- Eliminates the service_catalog vs catalog_entries drift problem.
-- After this migration:
--   - service_catalog physical table is renamed to _service_catalog_archive_20260601
--     (kept as rollback artifact; dropped in a separate migration after sandbox QA)
--   - service_catalog becomes a VIEW projecting catalog_entries 'services' rows
--     that have metadata->>'legacy_in_service_catalog' = 'true'
--   - INSTEAD OF trigger absorbs INSERT/UPDATE/DELETE on the view and translates
--     them to catalog_entries operations
--
-- Pre-conditions (already done):
--   - scripts/backfill-catalog-services.ts has been run against this database
--     to populate catalog_entries.metadata with the projected fields and set
--     legacy_in_service_catalog=true for every row that should appear in the view.
--   - Verified by: SELECT count(*) FROM catalog_entries WHERE catalog_id='services'
--     AND metadata->>'legacy_in_service_catalog' = 'true' — must equal the
--     row count of service_catalog before the rename.
--
-- Rollback (until the archive is dropped):
--   DROP VIEW service_catalog CASCADE;
--   ALTER TABLE _service_catalog_archive_20260601 RENAME TO service_catalog;
-- =====================================================================

BEGIN;

-- 1. Pre-condition check: row count parity. Aborts the transaction if the
--    backfill is missing any rows.
DO $$
DECLARE
  v_old_count int;
  v_new_count int;
BEGIN
  SELECT count(*) INTO v_old_count FROM service_catalog;
  SELECT count(*) INTO v_new_count
  FROM catalog_entries
  WHERE catalog_id = 'services' AND metadata->>'legacy_in_service_catalog' = 'true';
  IF v_old_count <> v_new_count THEN
    RAISE EXCEPTION 'Backfill row count mismatch: service_catalog has %, catalog_entries flagged has %. Run scripts/backfill-catalog-services.ts before re-applying this migration.',
      v_old_count, v_new_count;
  END IF;
END $$;

-- 2. Archive the existing table.
ALTER TABLE service_catalog RENAME TO _service_catalog_archive_20260601;

-- 3. Create the projection view.
CREATE VIEW service_catalog AS
SELECT
  ce.id,
  ce.slug,
  ce.display_name AS name,
  ce.description,
  (ce.status = 'active') AS active,
  ce.created_at,
  ce.updated_at,
  ce.metadata->>'pipeline'                                   AS pipeline,
  ce.metadata->>'contract_type'                              AS contract_type,
  CASE WHEN ce.metadata ? 'has_annual'
       THEN (ce.metadata->>'has_annual')::boolean ELSE NULL END AS has_annual,
  CASE WHEN ce.metadata ? 'default_price'
       THEN (ce.metadata->>'default_price')::numeric ELSE NULL END AS default_price,
  ce.metadata->>'default_currency'                           AS default_currency,
  CASE WHEN ce.metadata ? 'sort_order'
       THEN (ce.metadata->>'sort_order')::int ELSE NULL END  AS sort_order,
  ce.metadata->>'category'                                   AS category,
  CASE WHEN ce.metadata ? 'supports_quantity'
       THEN (ce.metadata->>'supports_quantity')::boolean ELSE NULL END AS supports_quantity,
  ce.metadata->>'default_service_context'                    AS default_service_context
FROM catalog_entries ce
WHERE ce.catalog_id = 'services'
  AND ce.metadata->>'legacy_in_service_catalog' = 'true';

-- 4. INSTEAD OF trigger function — translates view DML into catalog_entries DML.
CREATE OR REPLACE FUNCTION service_catalog_iud() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_existing_metadata jsonb;
  v_new_metadata      jsonb;
  v_new_status        text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Build the metadata payload from the projected fields.
    v_new_metadata := jsonb_build_object(
      'legacy_in_service_catalog', true,
      'legacy_name',               NEW.name,
      'pipeline',                  NEW.pipeline,
      'contract_type',             NEW.contract_type,
      'has_annual',                NEW.has_annual,
      'default_price',             NEW.default_price,
      'default_currency',          NEW.default_currency,
      'sort_order',                NEW.sort_order,
      'category',                  NEW.category,
      'description_legacy',        NEW.description,
      'supports_quantity',         NEW.supports_quantity,
      'default_service_context',   NEW.default_service_context
    );
    v_new_status := CASE WHEN COALESCE(NEW.active, true) THEN 'active' ELSE 'deprecated' END;

    INSERT INTO catalog_entries (
      catalog_id, slug, display_name, description, status, tags, metadata, capabilities,
      display_name_translations, description_translations
    )
    VALUES (
      'services', NEW.slug, NEW.name, NEW.description, v_new_status,
      '[]'::jsonb, v_new_metadata, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
    )
    RETURNING id INTO NEW.id;
    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    -- Merge new projected fields into existing metadata so non-projected keys
    -- (e.g. workflow_chain, tags, etc.) are preserved.
    SELECT metadata INTO v_existing_metadata FROM catalog_entries WHERE id = OLD.id;
    v_new_metadata := COALESCE(v_existing_metadata, '{}'::jsonb) || jsonb_build_object(
      'legacy_in_service_catalog', true,
      'legacy_name',               NEW.name,
      'pipeline',                  NEW.pipeline,
      'contract_type',             NEW.contract_type,
      'has_annual',                NEW.has_annual,
      'default_price',             NEW.default_price,
      'default_currency',          NEW.default_currency,
      'sort_order',                NEW.sort_order,
      'category',                  NEW.category,
      'description_legacy',        NEW.description,
      'supports_quantity',         NEW.supports_quantity,
      'default_service_context',   NEW.default_service_context
    );
    v_new_status := CASE WHEN COALESCE(NEW.active, true) THEN 'active' ELSE 'deprecated' END;

    UPDATE catalog_entries
       SET display_name = NEW.name,
           description  = NEW.description,
           status       = v_new_status,
           metadata     = v_new_metadata,
           updated_at   = now()
     WHERE id = OLD.id;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    -- Soft delete: mark deprecated and drop legacy flag so the view hides it.
    UPDATE catalog_entries
       SET status   = 'deprecated',
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('legacy_in_service_catalog', false),
           updated_at = now()
     WHERE id = OLD.id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

-- 5. Wire the trigger.
CREATE TRIGGER service_catalog_iud_trg
INSTEAD OF INSERT OR UPDATE OR DELETE ON service_catalog
FOR EACH ROW EXECUTE FUNCTION service_catalog_iud();

COMMIT;
