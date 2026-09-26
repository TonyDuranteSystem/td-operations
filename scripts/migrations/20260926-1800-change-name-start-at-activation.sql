-- Workspace-only plan S1 (dev job 9d34e750, Antonio approved 2026-09-26):
-- a bought Company Change Name is created AT PAYMENT on the contract's company
-- (DF Commerce, 2026-05-19, was never created). Company-scoped → deliberately
-- NOT tagged contact_eligible. Idempotent: re-running changes nothing.

-- 1. Tag it as a start-at-payment service (only if not tagged yet; tags must be an array).
UPDATE catalog_entries
SET tags = (
      SELECT jsonb_agg(DISTINCT t ORDER BY t)
      FROM jsonb_array_elements_text(tags || '["sd","start_at_activation"]'::jsonb) AS t
    ),
    updated_at = now()
WHERE catalog_id = 'services'
  AND slug = 'company_change_name'
  AND jsonb_typeof(tags) = 'array'
  AND NOT (tags @> '["start_at_activation"]'::jsonb);

-- 2. Race backstop for the payment step (mirrors uq_closure_sd_active_per_offer).
CREATE UNIQUE INDEX IF NOT EXISTS uq_change_name_sd_active_per_offer
  ON public.service_deliveries (account_id, source_offer_token)
  WHERE service_type = 'Company Change Name'
    AND status = 'active'
    AND source_offer_token IS NOT NULL;

-- 3. Link existing Change Name / EIN Change Name services to their catalog entry
--    (the runtime map now knows these types; historical rows had it NULL).
UPDATE service_deliveries sd
SET service_type_entry_id = ce.id
FROM catalog_entries ce
WHERE ce.catalog_id = 'services'
  AND sd.service_type_entry_id IS NULL
  AND ((sd.service_type = 'Company Change Name' AND ce.slug = 'company_change_name')
    OR (sd.service_type = 'EIN Change Name' AND ce.slug = 'ein_change_name'));

SELECT slug, tags FROM catalog_entries WHERE catalog_id = 'services' AND slug = 'company_change_name';
