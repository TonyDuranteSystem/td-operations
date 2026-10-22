-- Calendar team notes (Antonio 2026-10-21, from Luca's Calendar bug; dev job 388bb74b).
-- WHAT: one small append-only list of dated notes per job (service delivery): who wrote it, when, the text. Nothing is ever overwritten.
-- WHY A TABLE and not a column on service_deliveries: the job table is read with select('*') by several staff/AI/MCP paths and its updated_at
-- drives other screens; a note must not leak into those or move that clock. RLS is ON with NO policy: only the server (service role) can read or write.
-- Safe to run again. Undo: the .UNDO.sql beside this file.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.service_delivery_notes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_delivery_id uuid NOT NULL REFERENCES public.service_deliveries(id) ON DELETE CASCADE,
  body                text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000),
  author_user_id      uuid,
  author_name         text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS service_delivery_notes_job_idx ON public.service_delivery_notes (service_delivery_id, created_at DESC);

ALTER TABLE public.service_delivery_notes ENABLE ROW LEVEL SECURITY;

-- the standing rule for every new table (marketing database lock, 20261018-0110): keep new tables locked away from the marketing logins
-- (runs where that function exists — production; the sandbox copy of the lock is not installed, so it is skipped there)
DO $do$
BEGIN
  IF to_regprocedure('public.marketing_lock_all_tables()') IS NOT NULL THEN PERFORM public.marketing_lock_all_tables(); END IF;
END
$do$;

COMMIT;
