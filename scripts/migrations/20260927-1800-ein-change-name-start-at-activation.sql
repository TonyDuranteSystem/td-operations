-- Workspace-only plan S1 (dev job 9d34e750, Antonio approved 2026-09-27):
-- a bought EIN Change Name is created AT PAYMENT, like Company Change Name
-- (sold alone today it created nothing). Placed where the offer lives: on the
-- offer's company, else on the person — so it is deliberately NOT tagged
-- contact_eligible (the company is its home when there is one).
-- Idempotent: re-running changes nothing.

-- 1. Tag it as a start-at-payment service (only if not tagged yet; tags must be an array).
UPDATE catalog_entries
SET tags = (
      SELECT jsonb_agg(DISTINCT t ORDER BY t)
      FROM jsonb_array_elements_text(tags || '["sd","start_at_activation"]'::jsonb) AS t
    ),
    updated_at = now()
WHERE catalog_id = 'services'
  AND slug = 'ein_change_name'
  AND jsonb_typeof(tags) = 'array'
  AND NOT (tags @> '["start_at_activation"]'::jsonb);

-- 2. Race backstop for the payment step: one active service of each of these
--    types per offer, whether it sits on the company or on the person (the
--    account-keyed index cannot see person-level rows, where account_id is NULL).
CREATE UNIQUE INDEX IF NOT EXISTS uq_change_name_types_active_per_offer
  ON public.service_deliveries (service_type, source_offer_token)
  WHERE service_type IN ('Company Change Name', 'EIN Change Name')
    AND status = 'active'
    AND source_offer_token IS NOT NULL;

SELECT slug, tags FROM catalog_entries WHERE catalog_id = 'services' AND slug IN ('company_change_name', 'ein_change_name');
