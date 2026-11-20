-- UNDO of 20261120-0500-document-lock-ignores-empty-files.sql: the document lock counts any document row on the step again (an empty file counts too).
-- SAFE TO RE-RUN: does nothing when the condition is not there.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"document-lock-ignores-empty-files-undo"}', true);

DO $do$
DECLARE
  v_src  text;
  v_cond text := E'd.flow_stage = p.stage_name\n                        AND (d.file_size IS NULL OR d.file_size > 0));  -- an EMPTY (0-byte) file is not the step''s document (same rule as the app lock)';
  v_new  text;
BEGIN
  SELECT prosrc INTO v_src
    FROM pg_proc
   WHERE proname = 'trg_delivery_document_to_advance' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'document-lock-ignores-empty-files undo: the function trg_delivery_document_to_advance does not exist — nothing changed';
  END IF;
  IF position(v_cond in v_src) = 0 THEN
    RAISE NOTICE 'document-lock-ignores-empty-files undo: the condition is not there — nothing to do';
    RETURN;
  END IF;

  v_new := replace(v_src, v_cond, 'd.flow_stage = p.stage_name);');

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.trg_delivery_document_to_advance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'' AS %L',
    v_new);
END
$do$;

COMMIT;
