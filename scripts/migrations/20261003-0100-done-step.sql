-- N1a F1 — each service step says whether reaching it CLOSES the job (dev job be7da01a, plan v8 approved 2026-10-02).
--
-- Until now the code decided by the step's NAME ("Completed" / "TR Filed", or "Closed" for the two renewal services),
-- and "Mark complete" jumped to the highest-numbered step (for a tax return: "Terminated - Non Payment").
-- This adds pipeline_stages.completes_service and seeds it to reproduce today's name rule EXACTLY — no job closes at a
-- different step than before. Services without a done step (formation, ITIN, banking, shipping…) keep being closed by
-- their own actions; Antonio's step review (plan step C2) can mark their done steps later.
-- Safe to re-run. The code reads the flag when present and falls back to the name rule when it is not, so this can run
-- before or after the code deploy.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.pipeline_stages
  ADD COLUMN IF NOT EXISTS completes_service boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.pipeline_stages.completes_service IS
  'Reaching this step closes the job (status completed). N1a F1. Seeded from the old name rule: "Completed" / "TR Filed", or "Closed" for State RA Renewal / State Annual Report.';

UPDATE public.pipeline_stages
   SET completes_service = true
 WHERE completes_service = false
   AND (stage_name IN ('Completed', 'TR Filed')
        OR (stage_name = 'Closed' AND service_type IN ('State RA Renewal', 'State Annual Report')));

-- Parity: every step must now match the old rule exactly, and the three services that closed by step before still do.
DO $$
DECLARE v_mismatch integer; v_missing text;
BEGIN
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

COMMIT;
