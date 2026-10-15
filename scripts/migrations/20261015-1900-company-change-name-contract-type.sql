-- Name change sold on its own must be a 'company_change_name' contract so the
-- client signs the short Company Name Change agreement
-- (app/offer/[token]/contract/standalone-service-agreement.tsx) instead of the
-- LLC formation Master Service Agreement. Same failure as Company Closure
-- (20260928-1100-closure-contract-type.sql): the catalog row had no
-- contract_type, so deriveContractType() fell back to 'formation'.
-- Case: International Automobile Authority LLC, 2026-10-15. Combined with a
-- formation / onboarding / tax return those still win (deriveContractType).
-- Idempotent. EIN Change Name is deliberately NOT touched (no agreement text yet).
UPDATE catalog_entries
SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{contract_type}', '"company_change_name"'::jsonb, true),
    updated_at = now()
WHERE catalog_id = 'services'
  AND slug = 'company_change_name'
  AND (metadata->>'contract_type') IS DISTINCT FROM 'company_change_name';

SELECT slug, metadata->>'contract_type' AS contract_type FROM catalog_entries WHERE catalog_id = 'services' AND slug = 'company_change_name';
