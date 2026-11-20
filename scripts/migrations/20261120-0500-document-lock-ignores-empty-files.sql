-- The "a document must be uploaded on this step before the job can move on" lock stops counting an EMPTY file as the document (dev job a6bbea09, leftover from the
-- Company Closure production end-to-end test of 2026-11-10: a 0-byte "state confirmation" satisfied the lock and the job moved on).
--
-- WHAT: the database trigger `trg_delivery_document_to_advance` (BEFORE UPDATE on service_deliveries) looked for ANY `documents` row on the step. It now counts a row only
--   when its size is unknown (NULL) or above zero — the SAME rule the application lock already uses (lib/service-delivery.ts, step 4c: `file_size === null || > 0`) and the
--   upload route already refuses new empty files (lib/flows/upload-content-check.ts). So the trigger, the last line of defence, can no longer disagree with the app.
-- WHY NULL STILL COUNTS: a document whose size is not recorded is not "empty"; only a size of exactly 0 is. Production on 2026-11-20: 0 step documents with a NULL size, 1 with size 0
--   (on a job that is not active).
-- HOW: the function text is changed in place (one added condition inside the NOT EXISTS), so each database keeps its own comments, owner, permissions and `SET search_path`.
-- SAFE TO RE-RUN: does nothing when the condition is already there. It refuses to run if the function is not the shape production had on 2026-11-20 (nothing changed).
-- UNDO: 20261120-0500-document-lock-ignores-empty-files.UNDO.sql takes the condition out again.
-- Apply to SANDBOX first (node scripts/apply-migration.js); production on Antonio's word (he runs it).

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"document-lock-ignores-empty-files-migration"}', true);

DO $do$
DECLARE
  v_src    text;
  v_anchor text := 'd.flow_stage = p.stage_name);';
  v_new    text;
BEGIN
  SELECT prosrc INTO v_src
    FROM pg_proc
   WHERE proname = 'trg_delivery_document_to_advance' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'document-lock-ignores-empty-files: the function trg_delivery_document_to_advance does not exist — nothing changed';
  END IF;
  IF position('file_size' in v_src) > 0 THEN
    RAISE NOTICE 'document-lock-ignores-empty-files: already there — nothing to do';
    RETURN;
  END IF;
  IF position(v_anchor in v_src) = 0 OR position(v_anchor in substring(v_src from position(v_anchor in v_src) + length(v_anchor))) > 0 THEN
    RAISE EXCEPTION 'document-lock-ignores-empty-files: the function is not the expected shape (the "needs a document" check must appear exactly once) — nothing changed';
  END IF;

  v_new := replace(v_src, v_anchor,
    E'd.flow_stage = p.stage_name\n                        AND (d.file_size IS NULL OR d.file_size > 0));  -- an EMPTY (0-byte) file is not the step''s document (same rule as the app lock)');

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.trg_delivery_document_to_advance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'' AS %L',
    v_new);
END
$do$;

COMMIT;
