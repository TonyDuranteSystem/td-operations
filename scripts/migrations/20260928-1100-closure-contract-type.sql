-- Workspace-only plan S1 QA (dev job 9d34e750, 2026-09-28): a Company Closure
-- sold on its own must be a 'closure' contract, so the client signs the
-- Closure agreement (app/offer/[token]/contract/standalone-service-agreement.tsx
-- already has it) instead of the LLC formation / management Master Service
-- Agreement. The Create Offer dialog derives the contract type from each
-- service's catalog contract_type, and closure had none (so it fell back to
-- 'formation'). Combined with a formation or onboarding, those still win
-- (deriveContractType), so bundles are unchanged. Idempotent.
UPDATE catalog_entries
SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{contract_type}', '"closure"'::jsonb, true),
    updated_at = now()
WHERE catalog_id = 'services'
  AND slug = 'closure'
  AND (metadata->>'contract_type') IS DISTINCT FROM 'closure';

SELECT slug, metadata->>'contract_type' AS contract_type FROM catalog_entries WHERE catalog_id = 'services' AND slug = 'closure';
