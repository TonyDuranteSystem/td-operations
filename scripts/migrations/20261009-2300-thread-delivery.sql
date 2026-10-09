-- "Delivered" ticks for Team Chat / TD Talk direct messages and groups (dev job c1e326dd).
-- Antonio 2026-10-09: "grey double check when the other person's phone or app has actually received the message,
-- then blue when they read it."
--
-- One pointer per person per conversation: "this person's device has received everything up to delivered_at".
-- Written by the RECEIVING device (the app after it loads its chat list, or the service worker when a push arrives) —
-- never by the sender. Kept SEPARATE from internal_thread_reads on purpose: a read row means "participant" and drives
-- unread counts (get_team_threads), and a delivered-only row must not change either.
--
-- Additive only: one new table + one new function. Nothing existing is altered.
-- DDL must run BEFORE the code deploys. Production: Antonio runs this in the Supabase SQL editor.

BEGIN;

CREATE TABLE IF NOT EXISTS public.internal_thread_delivery (
  thread_id    uuid        NOT NULL REFERENCES public.internal_threads(id) ON DELETE CASCADE,
  user_id      uuid        NOT NULL,
  delivered_at timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_internal_thread_delivery_user
  ON public.internal_thread_delivery (user_id);

-- Same staff-only RLS as the sibling internal_* tables.
ALTER TABLE public.internal_thread_delivery ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'internal_thread_delivery'
       AND policyname = 'internal_thread_delivery_staff_all'
  ) THEN
    CREATE POLICY internal_thread_delivery_staff_all
      ON public.internal_thread_delivery
      FOR ALL
      USING (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client')
      WITH CHECK (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
       AND tablename = 'internal_thread_delivery'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.internal_thread_delivery;
  END IF;
END $$;

-- Only ever moves FORWARD (GREATEST): a late or repeated report can never un-deliver a message.
CREATE OR REPLACE FUNCTION public.mark_thread_delivered(p_user_id uuid, p_thread_id uuid, p_as_of timestamptz)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  INSERT INTO internal_thread_delivery (thread_id, user_id, delivered_at, updated_at)
  VALUES (p_thread_id, p_user_id, p_as_of, now())
  ON CONFLICT (thread_id, user_id) DO UPDATE
    SET delivered_at = GREATEST(internal_thread_delivery.delivered_at, EXCLUDED.delivered_at),
        updated_at   = now();
$function$;

COMMIT;
