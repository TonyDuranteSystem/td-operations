-- Migration: tag services that can be added at contact level (no account).
-- Branch: feat/wave2-events-and-add-service
-- Date: 2026-05-19
--
-- Adds the 'contact_eligible' tag to services that legitimately exist on a
-- contact without any account, per Master Rule A6 (individual services
-- like ITIN, Banking Physical can exist on a contact alone).
--
-- The new Add Service button on the contact-detail page filters the
-- catalog services dropdown by this tag — only contact_eligible services
-- appear. Adding a 7th eligible service tomorrow = one INSERT to add the
-- tag, no code change.
--
-- Services tagged:
--   - llc_formation        (formation, sold as service; SD is per-contact pre-materialization)
--   - company_formation    (the SD pipeline that drives formation lifecycle)
--   - itin                 (per Master Rule A6 — individual service, no account needed)
--   - banking_physical     (per Master Rule A6 — individual)
--   - notary               (one-off)
--   - shipping             (one-off)
--   - consulting           (consulting call, per-contact)
--
-- Idempotent: uses jsonb || to merge tag arrays; pre-filter on NOT (tags ? 'contact_eligible')
-- so re-runs don't duplicate.

UPDATE catalog_entries
   SET tags = COALESCE(tags, '[]'::jsonb) || '["contact_eligible"]'::jsonb,
       updated_at = now()
 WHERE catalog_id = 'services'
   AND slug IN ('llc_formation', 'company_formation', 'itin', 'banking_physical', 'notary', 'shipping', 'consulting')
   AND NOT (tags @> '["contact_eligible"]'::jsonb);
