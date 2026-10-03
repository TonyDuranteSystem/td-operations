-- N1a F1 — each service step says whether reaching it CLOSES the job (dev job be7da01a, plan v8 approved 2026-10-02).
--
-- Until now the code decided by the step's NAME ("Completed" / "TR Filed", or "Closed" for the two renewal services),
-- and "Mark complete" jumped to the highest-numbered step (for a tax return: "Terminated - Non Payment").
-- This adds pipeline_stages.completes_service and, the FIRST time only, seeds it to reproduce today's name rule
-- EXACTLY — no job closes at a different step than before. (The separate "all tasks of the step done -> move on; the
-- last step closes" automatic rule is untouched.) Services without a marked step keep being closed by their own
-- actions; Antonio's step review (plan step C2) can mark more later — re-running this file never undoes that.
-- The code reads the flag when present and falls back to the name rule when it is not, so this can run before or
-- after the code deploy.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE v_mismatch integer; v_missing text;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'pipeline_stages' AND column_name = 'completes_service') THEN
    RAISE NOTICE 'done-step: column already present — nothing to do';
    RETURN;
  END IF;

  ALTER TABLE public.pipeline_stages ADD COLUMN completes_service boolean NOT NULL DEFAULT false;
  COMMENT ON COLUMN public.pipeline_stages.completes_service IS
    'Reaching this step closes the job (status completed). N1a F1. Seeded from the old name rule: "Completed" / "TR Filed", or "Closed" for State RA Renewal / State Annual Report.';

  UPDATE public.pipeline_stages
     SET completes_service = true
   WHERE stage_name IN ('Completed', 'TR Filed')
      OR (stage_name = 'Closed' AND service_type IN ('State RA Renewal', 'State Annual Report'));

  -- Parity on the first seed: every step matches the old rule, and the services that closed by step still do.
  SELECT count(*) INTO v_mismatch FROM public.pipeline_stages
   WHERE completes_service IS DISTINCT FROM
         (stage_name IN ('Completed', 'TR Filed')
          OR (stage_name = 'Closed' AND service_type IN ('State RA Renewal', 'State Annual Report')));
  IF v_mismatch <> 0 THEN
    RAISE EXCEPTION 'done-step: % step(s) differ from the old name rule', v_mismatch;
  END IF;
  SELECT string_agg(t, ', ') INTO v_missing
    FROM unnest(ARRAY['State RA Renewal', 'State Annual Report', 'Tax Return']) AS t
   WHERE NOT EXISTS (SELECT 1 FROM public.pipeline_stages ps WHERE ps.service_type = t AND ps.completes_service);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'done-step: no done step found for %', v_missing;
  END IF;
END $$;

-- A step ADDED or RENAMED later (service editor, migrations) gets the same default as the old name rule, so a step
-- named "Completed" keeps closing jobs exactly as before (bug-hunter, N1a F1). Only fills in a missing "true"; never
-- turns a flag off. Revisit when the editor lets staff tick the done step (plan step C2).
CREATE OR REPLACE FUNCTION public.trg_pipeline_stage_done_default() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NOT COALESCE(NEW.completes_service, false)
     AND (NEW.stage_name IN ('Completed', 'TR Filed')
          OR (NEW.stage_name = 'Closed' AND NEW.service_type IN ('State RA Renewal', 'State Annual Report'))) THEN
    NEW.completes_service := true;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pipeline_stage_done_default ON public.pipeline_stages;
CREATE TRIGGER trg_pipeline_stage_done_default
  BEFORE INSERT OR UPDATE OF stage_name, service_type ON public.pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION public.trg_pipeline_stage_done_default();

REVOKE ALL ON FUNCTION public.trg_pipeline_stage_done_default() FROM PUBLIC, anon, authenticated;

COMMIT;
