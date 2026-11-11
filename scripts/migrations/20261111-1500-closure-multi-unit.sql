-- Migration: a Company Closure can be sold in quantity (one job per company) — dev job 9829a468 (child of a6bbea09).
-- Context (Antonio, 2026-11-11, Mario Gabriele Contrabona): a client bought a formation + the closure of TWO old
-- companies. The offer builder had no quantity box for Company Closure and payment created only one closure job, so
-- the second company had no job and no client form. A client who buys N closures must get N jobs, each with its own
-- portal form card and its own workspace, and the closure may be included in another price ($0).
--
-- 1) Catalog: `closure` gets the quantity box in the offer builder (metadata.supports_quantity = true) and the tag
--    `multi_unit` ("payment creates ONE JOB PER UNIT bought") — read by getMultiUnitServiceTypes()
--    (lib/services/index.ts). ITIN is NOT tagged: it also has a quantity box, but ITIN x2 means two different people
--    (the per_person tag), never two jobs for one person.
-- 2) service_deliveries.offer_unit (smallint, NULL = the first / only unit): which unit of the offer a job is.
-- 3) The per-offer closure lock becomes per UNIT: at most one active closure per (contact, offer, unit). This is
--    the race backstop for a retried / concurrent payment (a retry must still never create the same unit twice).
--
-- ROLLOUT ORDER: run this BEFORE the code (the new code only writes offer_unit when it is >= 2, so an old database
-- would refuse a quantity-2 closure, and nothing else changes). Safe to run any time before: old code ignores the
-- column and the new index is only looser (a 2nd unit with a different offer_unit).
--
-- PREFLIGHT (run first; must return 0 rows — the new index is looser than the old one, so this cannot fail):
--   SELECT contact_id, source_offer_token, count(*) FROM service_deliveries
--    WHERE service_type = 'Company Closure' AND status = 'active' AND source_offer_token IS NOT NULL
--    GROUP BY 1, 2 HAVING count(*) > 1;
--
-- Idempotent. UNDO: 20261111-1500-closure-multi-unit.UNDO.sql

UPDATE catalog_entries
   SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"supports_quantity": true}'::jsonb,
       tags = CASE WHEN COALESCE(tags, '[]'::jsonb) @> '["multi_unit"]'::jsonb
                   THEN tags
                   ELSE COALESCE(tags, '[]'::jsonb) || '["multi_unit"]'::jsonb END,
       updated_at = now()
 WHERE catalog_id = 'services'
   AND slug = 'closure';

ALTER TABLE service_deliveries ADD COLUMN IF NOT EXISTS offer_unit smallint;

COMMENT ON COLUMN service_deliveries.offer_unit IS
  'Which unit of a quantity offer this job is (2, 3, ...). NULL = the first or only unit. Part of the per-offer closure lock uq_closure_sd_active_per_offer.';

DROP INDEX IF EXISTS uq_closure_sd_active_per_offer;
CREATE UNIQUE INDEX IF NOT EXISTS uq_closure_sd_active_per_offer
  ON service_deliveries (contact_id, source_offer_token, (COALESCE(offer_unit, 1)))
  WHERE service_type = 'Company Closure'
    AND status = 'active'
    AND source_offer_token IS NOT NULL;
