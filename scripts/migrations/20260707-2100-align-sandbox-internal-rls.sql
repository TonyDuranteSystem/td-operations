-- Align SANDBOX RLS on internal_messages / internal_threads with PRODUCTION.
-- Production already has RLS ENABLED with a staff-only policy on both tables;
-- sandbox had RLS OFF (the divergence flagged as BUG-2). Beyond security, this
-- divergence broke Supabase Realtime in sandbox: postgres_changes authorizes
-- subscribers through RLS, so with RLS off the authenticated browser client
-- received no live INSERT/UPDATE events (messages only appeared after reload).
--
-- Idempotent: enables RLS only if off, creates each policy only if absent.
-- Prod is already in this state, so promoting this is a no-op there.

BEGIN;

ALTER TABLE public.internal_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_threads  ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='internal_messages'
       AND policyname='internal_messages_staff_all'
  ) THEN
    CREATE POLICY internal_messages_staff_all
      ON public.internal_messages FOR ALL
      USING (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client')
      WITH CHECK (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='internal_threads'
       AND policyname='internal_threads_staff_all'
  ) THEN
    CREATE POLICY internal_threads_staff_all
      ON public.internal_threads FOR ALL
      USING (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client')
      WITH CHECK (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client');
  END IF;
END $$;

COMMIT;
