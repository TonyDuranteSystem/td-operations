-- N1a C2 — step settings (dev job be7da01a; plan v3 saved 2026-10-04, Google Doc §20). Safe before the code deploy:
-- every new setting defaults to "no change" (waiting_on NULL, requires_document_to_advance false), so nothing live
-- behaves differently until a step is configured.
--
--   1. pipeline_stages.waiting_on — who must act next while a job sits on the step (us | client | outside | date |
--      none). Read by the Operations Calendar (C3); nothing reads it yet.
--   2. pipeline_stages.requires_document_to_advance — a job may not move FORWARD past this step (leaving it, or
--      jumping over it) unless a document was uploaded on that step for that job. Going back is never blocked.
--      Enforced here, by the database, for every writer (workspace, step bar, contact page, MCP, client approvals).
--   3. One done step per service (unique index).
--   4. The done-default trigger (20261003-0100) no longer re-ticks a step on every save: it fills in "done" only on
--      INSERT or on an actual rename, and only when the service has no other done step — so an untick sticks.
-- Every change here is stamped "c2-migration" in service_settings_history (20261004-0100).

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"c2-migration"}', true);

-- 1 + 2. New step settings ------------------------------------------------------------------------------------------
ALTER TABLE public.pipeline_stages
  ADD COLUMN IF NOT EXISTS waiting_on text,
  ADD COLUMN IF NOT EXISTS requires_document_to_advance boolean NOT NULL DEFAULT false;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_stages_waiting_on_check') THEN
    ALTER TABLE public.pipeline_stages ADD CONSTRAINT pipeline_stages_waiting_on_check
      CHECK (waiting_on IS NULL OR waiting_on IN ('us', 'client', 'outside', 'date', 'none'));
  END IF;
END $$;

COMMENT ON COLUMN public.pipeline_stages.waiting_on IS
  'N1a C2: who must act next while a job sits on this step — us | client | outside | date | none. NULL = not set.';
COMMENT ON COLUMN public.pipeline_stages.requires_document_to_advance IS
  'N1a C2: a job may not move forward past this step unless a document was uploaded on it (documents.service_delivery_id + flow_stage). Going back is never blocked.';
COMMENT ON COLUMN public.pipeline_stages.sla_days IS
  'Follow-up days: after this many days on the step the job is flagged for follow-up (shown as "Follow-up days").';

-- 3. One done step per service --------------------------------------------------------------------------------------
DO $$
DECLARE v_dupes text;
BEGIN
  SELECT string_agg(service_type, ', ') INTO v_dupes FROM (
    SELECT service_type FROM public.pipeline_stages WHERE completes_service GROUP BY 1 HAVING count(*) > 1) d;
  IF v_dupes IS NOT NULL THEN
    RAISE EXCEPTION 'c2: more than one done step on %', v_dupes;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_one_done_per_service
  ON public.pipeline_stages (service_type) WHERE completes_service;

-- 4. Done-default: only fill in, never fight an explicit untick ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_pipeline_stage_done_default() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.stage_name IS NOT DISTINCT FROM OLD.stage_name
     AND NEW.service_type IS NOT DISTINCT FROM OLD.service_type THEN
    RETURN NEW;  -- not a rename: leave the flag exactly as written (an untick sticks)
  END IF;
  IF NOT COALESCE(NEW.completes_service, false)
     AND (NEW.stage_name IN ('Completed', 'TR Filed')
          OR (NEW.stage_name = 'Closed' AND NEW.service_type IN ('State RA Renewal', 'State Annual Report')))
     AND NOT EXISTS (SELECT 1 FROM public.pipeline_stages p
                      WHERE p.service_type = NEW.service_type AND p.completes_service AND p.id IS DISTINCT FROM NEW.id) THEN
    NEW.completes_service := true;
  END IF;
  RETURN NEW;
END $$;

-- 2b. The document guard on jobs ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_delivery_document_to_advance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_from int;
  v_to   int;
  v_missing text;
BEGIN
  IF NEW.stage IS NOT DISTINCT FROM OLD.stage THEN RETURN NEW; END IF;
  -- Test jobs are exempt, like the suite and renewal-close rules (job flagged as test) — and jobs of a test company.
  IF COALESCE(NEW.is_test, false) THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = NEW.account_id AND a.is_test) THEN RETURN NEW; END IF;

  SELECT stage_order INTO v_from FROM public.pipeline_stages WHERE service_type = NEW.service_type AND stage_name = OLD.stage;
  SELECT stage_order INTO v_to   FROM public.pipeline_stages WHERE service_type = NEW.service_type AND stage_name = NEW.stage;
  IF v_from IS NULL OR v_to IS NULL OR v_to <= v_from THEN RETURN NEW; END IF;  -- unknown step, or going back

  -- Every "needs a document" step being left or jumped over must have a document uploaded on it for this job.
  SELECT string_agg(p.stage_name, ', ' ORDER BY p.stage_order) INTO v_missing
    FROM public.pipeline_stages p
   WHERE p.service_type = NEW.service_type
     AND p.requires_document_to_advance
     AND p.stage_order >= v_from AND p.stage_order < v_to
     AND NOT EXISTS (SELECT 1 FROM public.documents d
                      WHERE d.service_delivery_id = NEW.id AND d.flow_stage = p.stage_name);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'A document must be uploaded on "%" before this job can move on.', v_missing
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.trg_delivery_document_to_advance() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_delivery_document_to_advance ON public.service_deliveries;
CREATE TRIGGER trg_delivery_document_to_advance
  BEFORE UPDATE OF stage ON public.service_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.trg_delivery_document_to_advance();

COMMIT;
