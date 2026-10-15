-- Services sold on their own must carry their own contract type so the client
-- signs the short agreement for THAT service (standalone-service-agreement.tsx)
-- instead of the LLC formation Master Service Agreement. Same gap as Company
-- Closure (20260928-1100) and Company Change Name (20261015-1900): no catalog
-- contract_type -> deriveContractType() fell back to 'formation'.
-- Sold WITH a formation / onboarding they render as an inline add-on agreement
-- (the formation / onboarding contract still wins as the main contract).
-- Idempotent.
UPDATE catalog_entries
SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{contract_type}', to_jsonb(v.ct), true),
    updated_at = now()
FROM (VALUES
  ('ein_change_name', 'ein_change_name'),
  ('shipping', 'shipping'),
  ('public_notary', 'public_notary'),
  ('consulting', 'consulting_call')
) AS v(slug, ct)
WHERE catalog_entries.catalog_id = 'services'
  AND catalog_entries.slug = v.slug
  AND (catalog_entries.metadata->>'contract_type') IS DISTINCT FROM v.ct;

SELECT slug, metadata->>'contract_type' AS contract_type FROM catalog_entries WHERE catalog_id = 'services' AND slug IN ('ein_change_name','shipping','public_notary','consulting');
