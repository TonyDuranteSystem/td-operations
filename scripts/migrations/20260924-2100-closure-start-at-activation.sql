-- Migration: Company Closure bundled in a FORMATION contract is created at payment.
-- Context: dev job 77b66080 (Antonio, 2026-09-24). Milan (magyardi-milan-2026)
-- paid Formation + Company Closure; activate-service's formation branch created
-- only the Company Formation SD and silently dropped the closure.
--
-- 1) Tag the `closure` catalog entry `start_at_activation` — read by
--    getStartAtActivationServiceTypes() (lib/services/index.ts). Code shipped
--    without this tag is a no-op (safe rollout order either way).
-- 2) Race safety: at most ONE active Company Closure SD per (contact, offer)
--    created from a paid offer. Scoped to Company Closure ONLY — ITIN is
--    per-person and legitimately has several active SDs sharing one
--    source_offer_token (prod has such a pair), so a generic per-offer index
--    would fail / silently drop a member's ITIN.
--
-- PREFLIGHT (run first; must return 0 rows):
--   SELECT contact_id, source_offer_token, count(*)
--     FROM service_deliveries
--    WHERE service_type = 'Company Closure' AND status = 'active'
--      AND source_offer_token IS NOT NULL
--    GROUP BY 1, 2 HAVING count(*) > 1;
--
-- Idempotent.

UPDATE catalog_entries
   SET tags = COALESCE(tags, '[]'::jsonb) || '["start_at_activation"]'::jsonb,
       updated_at = now()
 WHERE catalog_id = 'services'
   AND slug = 'closure'
   AND NOT (tags @> '["start_at_activation"]'::jsonb);

CREATE UNIQUE INDEX IF NOT EXISTS uq_closure_sd_active_per_offer
  ON service_deliveries (contact_id, source_offer_token)
  WHERE service_type = 'Company Closure'
    AND status = 'active'
    AND source_offer_token IS NOT NULL;
