-- N1a C0 — a registered-agent renewal or an annual report can only be CLOSED by "Mark Filed" on the Calendar
-- (Antonio, plan v8 approved 2026-10-02, dev job be7da01a).
--
-- Why: closing one of these jobs is what moves the company's next renewal date forward a year. Today any path
-- can close it (tracker board, account page, workspace stepper, workflow handler, CRM update tool, SQL) and
-- only Mark Filed also saves the receipt and updates the calendar entry. Two closings for one year pushed a
-- company's next annual report two years ahead.
--
-- What this file adds (safe to re-run; run in sandbox first, then production on Antonio's word):
--   1. service_deliveries.filing_receipt_document_id — the filing receipt (documents row) a closing carries.
--   2. Two settings on the two service cards (catalog_entries, catalog 'services'), matched by SLUG (ids differ
--      between environments): closes_only_by_filing = true, and delivery_service_type = the job name, so a job
--      that is not linked to its card is still recognised. Logged in catalog_decision_log.
--   3. A database rule on service_deliveries: a job whose card says closes_only_by_filing can only become
--      'completed' in the same write that attaches a filing receipt of the SAME company. Reopening the job clears
--      the receipt, so a later close needs a new Mark Filed. Test jobs (is_test) are exempt, like the suite rule.
--      Cancelling, reopening, moving steps, editing anything else: untouched.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ─── 1. The receipt a closing carries ────────────────────────────────────────
ALTER TABLE public.service_deliveries
  ADD COLUMN IF NOT EXISTS filing_receipt_document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.service_deliveries.filing_receipt_document_id IS
  'Filing receipt attached when the job was closed by Mark Filed (N1a C0). Required to close a job whose service card has closes_only_by_filing. Cleared when the job is reopened.';

-- ─── 2. The settings on the two cards (logged) ───────────────────────────────
WITH upd AS (
  UPDATE public.catalog_entries ce
     SET metadata = COALESCE(ce.metadata, '{}'::jsonb)
                    || jsonb_build_object('closes_only_by_filing', true,
                                          'delivery_service_type', v.job_name),
         updated_at = now()
    FROM (VALUES ('state_ra_renewal', 'State RA Renewal'),
                 ('state_annual_report', 'State Annual Report')) AS v(slug, job_name)
   WHERE ce.catalog_id = 'services'
     AND ce.slug = v.slug
     AND (ce.metadata->>'closes_only_by_filing' IS DISTINCT FROM 'true'
          OR ce.metadata->>'delivery_service_type' IS DISTINCT FROM v.job_name)
  RETURNING ce.id, ce.slug, ce.metadata
)
INSERT INTO public.catalog_decision_log (catalog_entry_id, catalog_id, action, actor_kind, reason, after_state)
SELECT upd.id, 'services', 'metadata_changed', 'migration',
       'N1a C0: closes only by Mark Filed (20261002-2300-renewal-close-guard.sql)',
       jsonb_build_object('slug', upd.slug, 'metadata', upd.metadata)
  FROM upd;

-- ─── 3. The rule ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_delivery_renewal_close_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_closing boolean; v_guarded boolean; v_receipt_ok boolean;
BEGIN
  -- Reopening (completed -> anything else): the old receipt no longer closes it.
  IF TG_OP = 'UPDATE' AND OLD.status = 'completed' AND NEW.status IS DISTINCT FROM 'completed' THEN
    NEW.filing_receipt_document_id := NULL;
    RETURN NEW;
  END IF;

  v_closing := NEW.status = 'completed'
               AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'completed');
  IF NOT v_closing THEN RETURN NEW; END IF;
  IF COALESCE(NEW.is_test, false) THEN RETURN NEW; END IF;

  SELECT EXISTS (
    SELECT 1 FROM catalog_entries ce
     WHERE ce.catalog_id = 'services'
       AND ce.metadata->>'closes_only_by_filing' = 'true'
       AND (ce.id = NEW.service_type_entry_id OR ce.metadata->>'delivery_service_type' = NEW.service_type)
  ) INTO v_guarded;
  IF NOT v_guarded THEN RETURN NEW; END IF;

  -- The receipt must be attached in THIS write (not left over) and belong to the same company.
  v_receipt_ok := NEW.filing_receipt_document_id IS NOT NULL
                  AND (TG_OP = 'INSERT' OR NEW.filing_receipt_document_id IS DISTINCT FROM OLD.filing_receipt_document_id)
                  AND EXISTS (SELECT 1 FROM documents d
                               WHERE d.id = NEW.filing_receipt_document_id
                                 AND d.account_id IS NOT DISTINCT FROM NEW.account_id);
  IF NOT v_receipt_ok THEN
    RAISE EXCEPTION 'A registered-agent renewal or an annual report can only be closed with "Mark Filed" on the Calendar — it saves the receipt and moves the next date. (%)', NEW.service_type
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_delivery_renewal_close_guard ON public.service_deliveries;
CREATE TRIGGER trg_delivery_renewal_close_guard
  BEFORE INSERT OR UPDATE OF status, filing_receipt_document_id ON public.service_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.trg_delivery_renewal_close_guard();

REVOKE ALL ON FUNCTION public.trg_delivery_renewal_close_guard() FROM PUBLIC, anon, authenticated;

COMMIT;
