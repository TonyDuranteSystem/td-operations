-- Close anon (and client/partner) access to `action_log` and `email_tracking`.
--
-- THE BUG — a DIFFERENT shape from the previous batches. These five policies do
-- not use the broken COALESCE predicate; their expression is literally `true`,
-- on role `public` (which includes `anon`). The names are aspirational, not
-- descriptive: "Allow service role INSERT" is not restricted to the service role,
-- and "Allow realtime SELECT for authenticated and anon" really does admit anon.
--
-- EXPOSURE BEFORE THIS FIX:
--   action_log      13,408 rows — the complete audit trail of every write in the
--                   system. anon held SELECT *and DELETE/TRUNCATE grants*, so an
--                   anonymous caller could read it and then destroy it — the very
--                   record that would evidence a breach.
--   email_tracking   1,102 rows — recipient addresses and open/click history for
--                   every tracked client email; readable and writable by anon.
--
-- WHY THIS SCRIPT ALSO CHANGES THE PREDICATE (unlike 20260720-2300, which changed
-- only the role): `TO authenticated` alone would leave `USING (true)`, so any
-- logged-in CLIENT or PARTNER could still read the entire audit log. Both the role
-- AND the condition have to move. That makes this batch slightly riskier than the
-- last — a mistyped predicate could lock staff out — so it is wrapped in
-- BEGIN/COMMIT (policy DDL is transactional; a typo aborts and changes nothing),
-- and the predicate is COPIED VERBATIM from `gmail_push_events_staff_select`,
-- which is already live and working on production.
--
-- That predicate is also the BEST one in the codebase — it is an explicit
-- exclusion of both client and partner, which is what the council asked for when
-- it flagged that `<> 'client'` alone still admits partner-role users. Prefer this
-- form for any new staff policy.
--
-- VERIFIED SAFE — every consumer checked against the code before applying:
--   action_log      writers: all `supabaseAdmin` (service_role — bypasses RLS).
--                   readers: app/(dashboard)/audit/page.tsx and
--                   app/(dashboard)/tools/fax/history/page.tsx via
--                   lib/supabase/server (authenticated staff);
--                   components/dashboard/cards/{recent-activity,today-events}.tsx
--                   via supabase-admin (service_role).
--                   realtime: components/dashboard/realtime-notifications.tsx:242
--                   subscribes via the BROWSER client as authenticated staff —
--                   staff are role 'admin'/'team', so they pass the new predicate.
--   email_tracking  writers: all `supabaseAdmin` (portal invoice send, resend-offer,
--                   lib/offers/publish.ts, and the lease/gmail/offers/portal/oa MCP
--                   tools). reader: app/(dashboard)/leads/[id]/page.tsx via
--                   lib/supabase/server (authenticated staff).
--                   THE OPEN-TRACKING PIXEL IS NOT AFFECTED:
--                   app/api/track/open/[id]/route.ts builds its own client with
--                   SUPABASE_SERVICE_ROLE_KEY and calls the increment_email_open
--                   RPC — it bypasses RLS entirely and never touches these policies.
--                   (This was the specific trap flagged in review: an anon-written
--                   tracking table would have gone silently to zero. It is not one.)
--
-- NOT IN SCOPE — `gmail_push_events` is ALREADY correct: its only policy is
-- gmail_push_events_staff_select, role {authenticated}, with exactly the predicate
-- used below. Nothing to do.
--
-- ROLLBACK (restores the previous, vulnerable state exactly):
--   BEGIN;
--   ALTER POLICY "Allow realtime SELECT for authenticated and anon" ON public.action_log TO public USING (true);
--   ALTER POLICY "Allow service role INSERT" ON public.action_log TO public WITH CHECK (true);
--   ALTER POLICY email_tracking_read   ON public.email_tracking TO public USING (true);
--   ALTER POLICY email_tracking_update ON public.email_tracking TO public USING (true);
--   ALTER POLICY email_tracking_insert ON public.email_tracking TO public WITH CHECK (true);
--   COMMIT;

BEGIN;

ALTER POLICY "Allow realtime SELECT for authenticated and anon" ON public.action_log
  TO authenticated
  USING (COALESCE((auth.jwt() -> 'app_metadata') ->> 'role', '') <> ALL (ARRAY['client', 'partner']));

ALTER POLICY "Allow service role INSERT" ON public.action_log
  TO authenticated
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata') ->> 'role', '') <> ALL (ARRAY['client', 'partner']));

ALTER POLICY email_tracking_read ON public.email_tracking
  TO authenticated
  USING (COALESCE((auth.jwt() -> 'app_metadata') ->> 'role', '') <> ALL (ARRAY['client', 'partner']));

ALTER POLICY email_tracking_update ON public.email_tracking
  TO authenticated
  USING (COALESCE((auth.jwt() -> 'app_metadata') ->> 'role', '') <> ALL (ARRAY['client', 'partner']));

ALTER POLICY email_tracking_insert ON public.email_tracking
  TO authenticated
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata') ->> 'role', '') <> ALL (ARRAY['client', 'partner']));

COMMIT;

-- VERIFY (expect zero rows):
-- SELECT tablename, policyname, roles::text, qual, with_check FROM pg_policies
-- WHERE schemaname='public' AND tablename IN ('action_log','email_tracking')
--   AND (roles::text LIKE '%public%' OR roles::text LIKE '%anon%');
