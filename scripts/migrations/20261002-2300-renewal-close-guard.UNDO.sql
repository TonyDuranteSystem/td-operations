-- UNDO for 20261002-2300-renewal-close-guard.sql — removes the rule and the two card settings.
-- The receipt column is kept (dropping it would lose which receipt closed which job); drop it by hand if wanted.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_delivery_renewal_close_guard ON public.service_deliveries;
DROP FUNCTION IF EXISTS public.trg_delivery_renewal_close_guard();

WITH upd AS (
  UPDATE public.catalog_entries ce
     SET metadata = ce.metadata - 'closes_only_by_filing' - 'delivery_service_type', updated_at = now()
   WHERE ce.catalog_id = 'services'
     AND ce.slug IN ('state_ra_renewal', 'state_annual_report')
     AND (ce.metadata ? 'closes_only_by_filing' OR ce.metadata ? 'delivery_service_type')
  RETURNING ce.id, ce.slug, ce.metadata
)
INSERT INTO public.catalog_decision_log (catalog_entry_id, catalog_id, action, actor_kind, reason, after_state)
SELECT upd.id, 'services', 'metadata_changed', 'migration',
       'UNDO N1a C0 (20261002-2300-renewal-close-guard.UNDO.sql)',
       jsonb_build_object('slug', upd.slug, 'metadata', upd.metadata)
  FROM upd;

COMMIT;
