-- Close unauthenticated access to `payments`.
--
-- APPLIED TO PRODUCTION 2026-07-20 by Antonio in the Supabase SQL editor.
-- (The MCP execute_sql path cannot run DROP POLICY — exec_sql only classifies
--  INSERT/UPDATE/DELETE/WITH/CREATE/ALTER as mutations, so DROP falls to the
--  read branch and errors. CREATE POLICY / ALTER POLICY / ALTER VIEW do work.)
--
-- THE BUG: four policies were granted to role `public`, which INCLUDES `anon`.
-- Their predicate was:
--     COALESCE((auth.jwt() -> 'app_metadata') ->> 'role', '') <> 'client'
-- For an unauthenticated request auth.jwt() is NULL, so the COALESCE yields ''
-- and '' <> 'client' is TRUE. The predicate excluded logged-in CLIENTS only —
-- it never excluded the public. Result: anon could SELECT, UPDATE and DELETE
-- every payment row in production.
--
-- I had previously reported this table to Antonio as "properly scoped, do not
-- touch". That was WRONG: the audit query that cleared it filtered on `qual`
-- and never inspected `roles`. Corrected 2026-07-20.
--
-- ⚠️ THE SAME BROKEN SHAPE IS STILL DEPLOYED ELSEWHERE — a bare
-- `COALESCE(...) <> 'client'` with NO `TO` clause appears on internal_messages,
-- internal_threads, the Slack-mirror and team-thread tables (migrations
-- 20260707-2100, 20260708-0300, 20260717-1730/2100/2200, 20260718-1700,
-- 20260626-1500, 20260709-0100). Those are anon-readable today. Tracked on dev
-- job 023c7d06.
--
-- THE RULE, going forward: a staff predicate MUST pin the role explicitly.
-- Correct form (precedent: 20260503-2200-address-registry-prod-backfill.sql:52-55):
--     TO authenticated
--     USING (COALESCE((auth.jwt() -> 'app_metadata') ->> 'role', '') <> 'client')
-- The `TO authenticated` clause is the actual control — it stops the policy from
-- ever being evaluated for anon, so a NULL jwt cannot slip through the COALESCE.
--
-- WHY THIS IS SAFE (verified before applying): NOTHING reads or writes
-- `payments` from a browser. Every call site is server-side — either
-- supabase-admin (service_role, covered by service_role_all_payments) or
-- lib/supabase/server (acts as `authenticated`, covered by the policies below).
-- SELECT is deliberately NOT recreated: `auth_read_payments` already exists,
-- is scoped TO authenticated, and correctly lets staff see everything while a
-- client sees only their own accounts.
--
-- VERIFIED AFTER APPLYING: all payments policies now carry roles
-- {authenticated} or {service_role}; no {public} remains. Beril LLC's Payments
-- tab renders 14 payments totalling $2,432.00 on production.
--
-- ROLLBACK (restores the previous, vulnerable state exactly):
--   BEGIN;
--   DROP POLICY IF EXISTS payments_staff_insert ON public.payments;
--   DROP POLICY IF EXISTS payments_staff_update ON public.payments;
--   DROP POLICY IF EXISTS payments_staff_delete ON public.payments;
--   CREATE POLICY payments_staff_read   ON public.payments FOR SELECT USING (COALESCE((auth.jwt()->'app_metadata')->>'role','') <> 'client');
--   CREATE POLICY payments_staff_update ON public.payments FOR UPDATE USING (COALESCE((auth.jwt()->'app_metadata')->>'role','') <> 'client');
--   CREATE POLICY payments_staff_insert ON public.payments FOR INSERT WITH CHECK (COALESCE((auth.jwt()->'app_metadata')->>'role','') <> 'client');
--   CREATE POLICY payments_staff_delete ON public.payments FOR DELETE USING (COALESCE((auth.jwt()->'app_metadata')->>'role','') <> 'client');
--   COMMIT;

BEGIN;

DROP POLICY IF EXISTS payments_staff_read   ON public.payments;
DROP POLICY IF EXISTS payments_staff_update ON public.payments;
DROP POLICY IF EXISTS payments_staff_insert ON public.payments;
DROP POLICY IF EXISTS payments_staff_delete ON public.payments;

CREATE POLICY payments_staff_insert ON public.payments
  FOR INSERT TO authenticated
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata') ->> 'role', '') <> 'client');

CREATE POLICY payments_staff_update ON public.payments
  FOR UPDATE TO authenticated
  USING      (COALESCE((auth.jwt() -> 'app_metadata') ->> 'role', '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata') ->> 'role', '') <> 'client');

CREATE POLICY payments_staff_delete ON public.payments
  FOR DELETE TO authenticated
  USING (COALESCE((auth.jwt() -> 'app_metadata') ->> 'role', '') <> 'client');

COMMIT;

-- VERIFY (expect no row with roles containing 'public'):
-- SELECT policyname, cmd, roles::text FROM pg_policies
-- WHERE schemaname='public' AND tablename='payments' ORDER BY cmd;
