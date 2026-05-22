-- Migration: tag ITIN as a service that STARTS AT WIZARD SUBMIT.
-- Context: dev_task fcf5e254.
--
-- When a formation/onboarding offer bundles ITIN, the ITIN service delivery
-- must be created when the client submits the formation/onboarding wizard —
-- NOT deferred to company creation. ITIN is personal (the individual's tax ID,
-- ~2 months) and should start in parallel with formation, not wait for the
-- company to exist. Company-bound services (Company Formation, Banking) stay
-- deferred to company creation / EIN.
--
-- This tag makes that classification DATA-DRIVEN, not a hardcoded 'ITIN' string
-- in business logic. Adding another start-at-wizard personal service tomorrow =
-- one tag here, no code change. Read via getStartAtWizardServiceTypes() in
-- lib/services/index.ts.
--
-- Idempotent: jsonb || merge, guarded by NOT (tags @> ...).

UPDATE catalog_entries
   SET tags = COALESCE(tags, '[]'::jsonb) || '["start_at_wizard"]'::jsonb,
       updated_at = now()
 WHERE catalog_id = 'services'
   AND slug = 'itin'
   AND NOT (tags @> '["start_at_wizard"]'::jsonb);
