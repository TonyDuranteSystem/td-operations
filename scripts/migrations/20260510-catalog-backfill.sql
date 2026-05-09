-- ============================================================================
-- Catalog Framework — Phase 2: Backfill FK columns from existing text values
-- ============================================================================
-- Phase 1 (PR #30) added 5 nullable FK columns pointing at catalog_entries.
-- This migration populates them from the legacy text columns, leaving the
-- text columns untouched. Phase 3 will tighten constraints (NOT NULL,
-- application-side dual-write retirement).
--
-- Tables touched:
--   service_deliveries.service_type_entry_id   (uuid)
--   pipeline_stages.service_type_entry_id      (uuid)
--   client_partners.agreed_service_entry_ids   (jsonb)
--   offers.bundled_pipeline_entry_ids          (jsonb)
--   accounts.services_bundle_entry_ids         (jsonb)
--
-- Sandbox-only via apply-migration.js. Promote to production with
--   execute_sql(mode='write', reason='migration:20260510-catalog-backfill.sql')
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Ensure the `banking_physical` catalog entry exists.
--    `Banking Physical` is still a live service type in the codebase
--    (lib/operations/service-types.ts, lib/constants.ts, pipeline actions).
--    Phase 1 omitted it; we add it here so the FK target is present before
--    backfilling pipeline_stages and offers.
-- ----------------------------------------------------------------------------
INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata, created_at, updated_at)
VALUES ('services', 'banking_physical', 'Banking Physical', 'active', '{}'::jsonb, now(), now())
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 1. service_deliveries.service_type → service_type_entry_id
--    Mapping is by display_name with explicit overrides for the 4 cases
--    where the SD text differs from the catalog display_name.
-- ----------------------------------------------------------------------------
UPDATE service_deliveries sd
SET service_type_entry_id = ce.id
FROM catalog_entries ce
WHERE ce.catalog_id = 'services'
  AND ce.slug = CASE sd.service_type
    WHEN 'State Annual Report'  THEN 'state_annual_report'
    WHEN 'CMRA Mailing Address' THEN 'cmra'
    WHEN 'State RA Renewal'     THEN 'state_ra_renewal'
    WHEN 'Tax Return'           THEN 'tax_return'
    WHEN 'Company Formation'    THEN 'company_formation'
    WHEN 'Annual Renewal'       THEN 'annual_renewal_sd'
    WHEN 'EIN'                  THEN 'ein'
    WHEN 'ITIN'                 THEN 'itin'
    WHEN 'Banking Fintech'      THEN 'banking'
    WHEN 'Banking Physical'     THEN 'banking_physical'
    WHEN 'Client Onboarding'    THEN 'client_onboarding'
    WHEN 'Company Closure'      THEN 'closure'
    ELSE NULL
  END
  AND sd.service_type IS NOT NULL
  AND sd.service_type_entry_id IS NULL;

-- ----------------------------------------------------------------------------
-- 2. pipeline_stages.service_type → service_type_entry_id
--    Same mapping as service_deliveries plus Company Closure / Banking Physical.
-- ----------------------------------------------------------------------------
UPDATE pipeline_stages ps
SET service_type_entry_id = ce.id
FROM catalog_entries ce
WHERE ce.catalog_id = 'services'
  AND ce.slug = CASE ps.service_type
    WHEN 'State Annual Report'  THEN 'state_annual_report'
    WHEN 'CMRA Mailing Address' THEN 'cmra'
    WHEN 'State RA Renewal'     THEN 'state_ra_renewal'
    WHEN 'Tax Return'           THEN 'tax_return'
    WHEN 'Company Formation'    THEN 'company_formation'
    WHEN 'Annual Renewal'       THEN 'annual_renewal_sd'
    WHEN 'EIN'                  THEN 'ein'
    WHEN 'ITIN'                 THEN 'itin'
    WHEN 'Banking Fintech'      THEN 'banking'
    WHEN 'Banking Physical'     THEN 'banking_physical'
    WHEN 'Client Onboarding'    THEN 'client_onboarding'
    WHEN 'Company Closure'      THEN 'closure'
    ELSE NULL
  END
  AND ps.service_type IS NOT NULL
  AND ps.service_type_entry_id IS NULL;

-- ----------------------------------------------------------------------------
-- 3. client_partners.agreed_services TEXT[] → agreed_service_entry_ids JSONB
--    Source values are snake_case keys, not catalog slugs. Note "formation"
--    here means LLC formation as a partner-agreed service (slug llc_formation),
--    distinct from the SD "Company Formation" service (slug company_formation).
--    Order is preserved via WITH ORDINALITY.
--    Idempotency note: the column default is '[]'::jsonb, so we treat both
--    NULL and the empty-array default as "needs backfill". Re-running the
--    migration on already-populated rows is a no-op (no row matches).
-- ----------------------------------------------------------------------------
UPDATE client_partners cp
SET agreed_service_entry_ids = (
  SELECT to_jsonb(array_agg(ce.id ORDER BY ord))
  FROM unnest(cp.agreed_services) WITH ORDINALITY AS s(svc, ord)
  JOIN catalog_entries ce
    ON ce.catalog_id = 'services'
   AND ce.slug = CASE s.svc
     WHEN 'cmra'           THEN 'cmra'
     WHEN 'formation'      THEN 'llc_formation'
     WHEN 'annual_report'  THEN 'state_annual_report'
     WHEN 'ra_renewal'     THEN 'state_ra_renewal'
     WHEN 'tax_return'     THEN 'tax_return'
     ELSE NULL
   END
)
WHERE cp.agreed_services IS NOT NULL
  AND array_length(cp.agreed_services, 1) > 0
  AND (cp.agreed_service_entry_ids IS NULL OR cp.agreed_service_entry_ids = '[]'::jsonb);

-- ----------------------------------------------------------------------------
-- 4. offers.bundled_pipelines TEXT[] → bundled_pipeline_entry_ids JSONB
--    Same display_name mapping as service_deliveries, plus an alias for
--    "EIN Application" (which appears alongside "EIN" in the data) → ein.
-- ----------------------------------------------------------------------------
UPDATE offers o
SET bundled_pipeline_entry_ids = (
  SELECT to_jsonb(array_agg(ce.id ORDER BY ord))
  FROM unnest(o.bundled_pipelines) WITH ORDINALITY AS s(bp, ord)
  JOIN catalog_entries ce
    ON ce.catalog_id = 'services'
   AND ce.slug = CASE s.bp
     WHEN 'State Annual Report'  THEN 'state_annual_report'
     WHEN 'CMRA Mailing Address' THEN 'cmra'
     WHEN 'State RA Renewal'     THEN 'state_ra_renewal'
     WHEN 'Tax Return'           THEN 'tax_return'
     WHEN 'Company Formation'    THEN 'company_formation'
     WHEN 'Annual Renewal'       THEN 'annual_renewal_sd'
     WHEN 'EIN'                  THEN 'ein'
     WHEN 'EIN Application'      THEN 'ein'
     WHEN 'ITIN'                 THEN 'itin'
     WHEN 'Banking Fintech'      THEN 'banking'
     WHEN 'Banking Physical'     THEN 'banking_physical'
     WHEN 'Client Onboarding'    THEN 'client_onboarding'
     WHEN 'Company Closure'      THEN 'closure'
     ELSE NULL
   END
)
WHERE o.bundled_pipelines IS NOT NULL
  AND array_length(o.bundled_pipelines, 1) > 0
  AND (o.bundled_pipeline_entry_ids IS NULL OR o.bundled_pipeline_entry_ids = '[]'::jsonb);

-- ----------------------------------------------------------------------------
-- 5. accounts.services_bundle TEXT[] → services_bundle_entry_ids JSONB
--    Non-canonical text values. Special cases:
--      - "One-Time Service" expands to nothing (these accounts have no
--        recurring bundle); a row whose only value is "One-Time Service"
--        receives '[]' rather than NULL.
--      - "Full Service" expands to the 4 LLC Management entries:
--        state_ra_renewal, state_annual_report, cmra, tax_return
--        (canonical bundle per lib/mcp/tools/portal.ts:286,
--         app/api/portal/admin/transition/route.ts:269,
--         app/api/cron/annual-renewal-msa/route.ts:160).
--      - "Mailing Service" is an old alias for CMRA.
--    DISTINCT prevents double-counting if Full Service overlaps with another
--    explicit value on the same account.
-- ----------------------------------------------------------------------------
UPDATE accounts a
SET services_bundle_entry_ids = COALESCE(
  (
    SELECT to_jsonb(array_agg(DISTINCT ce.id))
    FROM unnest(a.services_bundle) AS s(svc)
    JOIN (VALUES
      ('State Renewal',    'state_annual_report'),
      ('Tax',              'tax_return'),
      ('Banking',          'banking'),
      ('CMRA',             'cmra'),
      ('ITIN',             'itin'),
      ('Mailing Service',  'cmra'),
      ('Full Service',     'state_ra_renewal'),
      ('Full Service',     'state_annual_report'),
      ('Full Service',     'cmra'),
      ('Full Service',     'tax_return')
    ) AS map(text_value, slug) ON map.text_value = s.svc
    JOIN catalog_entries ce
      ON ce.catalog_id = 'services'
     AND ce.slug = map.slug
  ),
  '[]'::jsonb
)
WHERE a.services_bundle IS NOT NULL
  AND array_length(a.services_bundle, 1) > 0
  AND (a.services_bundle_entry_ids IS NULL OR a.services_bundle_entry_ids = '[]'::jsonb);

-- ----------------------------------------------------------------------------
-- 6. Surface any unmapped rows so apply-migration logs flag them.
--    Per spec: log and skip; do not fail.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_sd  int;
  v_ps  int;
  v_cp  int;
  v_off int;
  v_acc int;
  v_unmapped_sd  text;
  v_unmapped_ps  text;
  v_unmapped_off text;
  v_unmapped_acc text;
BEGIN
  SELECT count(*) INTO v_sd  FROM service_deliveries
    WHERE service_type IS NOT NULL AND service_type_entry_id IS NULL;
  SELECT count(*) INTO v_ps  FROM pipeline_stages
    WHERE service_type IS NOT NULL AND service_type_entry_id IS NULL;
  -- For JSONB columns, treat both NULL and empty-array as "needs backfill"
  -- (empty-array is the column DEFAULT). Exception: accounts whose
  -- services_bundle is *only* 'One-Time Service' legitimately receive '[]'.
  SELECT count(*) INTO v_cp  FROM client_partners
    WHERE agreed_services IS NOT NULL AND array_length(agreed_services, 1) > 0
      AND (agreed_service_entry_ids IS NULL OR agreed_service_entry_ids = '[]'::jsonb);
  SELECT count(*) INTO v_off FROM offers
    WHERE bundled_pipelines IS NOT NULL AND array_length(bundled_pipelines, 1) > 0
      AND (bundled_pipeline_entry_ids IS NULL OR bundled_pipeline_entry_ids = '[]'::jsonb);
  SELECT count(*) INTO v_acc FROM accounts
    WHERE services_bundle IS NOT NULL AND array_length(services_bundle, 1) > 0
      AND (services_bundle_entry_ids IS NULL OR services_bundle_entry_ids = '[]'::jsonb)
      -- Accounts whose bundle is *only* 'One-Time Service' are intentionally [].
      AND NOT (services_bundle = ARRAY['One-Time Service']::text[]);

  RAISE NOTICE '── Catalog backfill — null-FK survivors ──';
  RAISE NOTICE '  service_deliveries: %', v_sd;
  RAISE NOTICE '  pipeline_stages:    %', v_ps;
  RAISE NOTICE '  client_partners:    %', v_cp;
  RAISE NOTICE '  offers:             %', v_off;
  RAISE NOTICE '  accounts:           %', v_acc;

  IF v_sd > 0 THEN
    SELECT string_agg(DISTINCT service_type, ', ') INTO v_unmapped_sd
      FROM service_deliveries
      WHERE service_type IS NOT NULL AND service_type_entry_id IS NULL;
    RAISE NOTICE '  ⚠ unmapped SD service_types: %', v_unmapped_sd;
  END IF;
  IF v_ps > 0 THEN
    SELECT string_agg(DISTINCT service_type, ', ') INTO v_unmapped_ps
      FROM pipeline_stages
      WHERE service_type IS NOT NULL AND service_type_entry_id IS NULL;
    RAISE NOTICE '  ⚠ unmapped pipeline_stages service_types: %', v_unmapped_ps;
  END IF;
  IF v_off > 0 THEN
    SELECT string_agg(DISTINCT bp, ', ') INTO v_unmapped_off
      FROM (
        SELECT DISTINCT unnest(bundled_pipelines) AS bp
        FROM offers
        WHERE bundled_pipelines IS NOT NULL AND array_length(bundled_pipelines, 1) > 0
          AND (bundled_pipeline_entry_ids IS NULL OR bundled_pipeline_entry_ids = '[]'::jsonb)
      ) sub;
    RAISE NOTICE '  ⚠ unmapped offers bundled_pipelines values: %', v_unmapped_off;
  END IF;
  IF v_acc > 0 THEN
    SELECT string_agg(DISTINCT svc, ', ') INTO v_unmapped_acc
      FROM (
        SELECT DISTINCT unnest(services_bundle) AS svc
        FROM accounts
        WHERE services_bundle IS NOT NULL AND array_length(services_bundle, 1) > 0
          AND (services_bundle_entry_ids IS NULL OR services_bundle_entry_ids = '[]'::jsonb)
          AND NOT (services_bundle = ARRAY['One-Time Service']::text[])
      ) sub;
    RAISE NOTICE '  ⚠ unmapped accounts services_bundle values: %', v_unmapped_acc;
  END IF;
END $$;

COMMIT;
