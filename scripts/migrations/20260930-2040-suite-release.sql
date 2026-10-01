-- Suite release (Antonio 2026-09-30): "as soon as available" — a suite goes back to the pool and is given to the next
-- new company, oldest released number first, the moment BOTH are true:
--     1) the company is Closed or Cancelled  (never Suspended / Offboarding / Delinquent / Pending Formation — those
--        can come back, and a returning company would find its number given away);
--     2) it has NO lease in force — a lease that went to the client (sent / viewed / signed) whose term has not ended.
--        Otherwise two companies would hold a lease on the same suite until the old one ends. Delete the old lease
--        (owner-only "Delete lease") or wait for its term to end; the number is released automatically at that point.
--
-- Run AFTER 20260930-2000-suite-lock.sql (which has the suite_pool table and the allocator that takes from it first).
-- WHAT THIS DOES NOT COVER: a company that holds its number ONLY on a lease record and not on the company itself — that
-- is exactly the state of the two companies the repair does not load (SupraEmerge, closed; Degasper, suspended). Their
-- numbers are NOT released and NOT reused, now or when their lease ends (there is no company-level number to release).
-- Enforced by the DATABASE so no writer of accounts.status can miss it; the daily sweep covers a lease ending later and a
-- busy moment, and also frees reservations whose formation/onboarding was cancelled or deleted. Safe to re-run.
-- (This file no longer redefines admin_delete_lease — the final version, with the release, lives in 20260930-2000.)

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ─── 1. "Is a lease in force?" ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.td_company_has_lease_in_force(p_account uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.lease_agreements
    WHERE account_id = p_account
      AND status IN ('sent', 'viewed', 'signed')
      AND COALESCE(term_end_date, DATE '9999-12-31') >= current_date
  )
$$;

-- ─── 2. Shared helpers: one place for "number goes to the pool" and "the Largo address line for a suite" ─────
CREATE OR REPLACE FUNCTION public._largo_address_for_suite(p_suite text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT '10225 Ulmerton Rd, Suite ' || p_suite || ', Largo, FL 33771' $$;

-- Caller holds the allocator lock. Puts the number in the pool (once) and writes the history row.
CREATE OR REPLACE FUNCTION public._suite_to_pool(p_suite text, p_account uuid, p_reason text, p_actor text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO suite_pool (suite_number, released_from_account, reason)
    VALUES (p_suite, p_account, p_reason) ON CONFLICT (suite_number) DO NOTHING;
  INSERT INTO suite_audit_log (suite_number, account_id, action, old_suite, reason, actor)
    VALUES (p_suite, p_account, 'released_to_pool', p_suite, p_reason, p_actor);
END $$;

-- ─── 3. Release one company's suite to the pool (only when it is truly free) ─────────────────────────────
CREATE OR REPLACE FUNCTION public._release_company_suite_impl(p_account uuid, p_reason text, p_actor text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_suite text; v_status text; v_addr text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('td_suite_allocator'));
  SELECT suite_number, status, physical_address INTO v_suite, v_status, v_addr FROM accounts WHERE id = p_account FOR UPDATE;
  IF NOT FOUND OR v_suite IS NULL THEN RETURN NULL; END IF;
  IF v_status NOT IN ('Closed', 'Cancelled') THEN RETURN NULL; END IF;
  IF td_company_has_lease_in_force(p_account) THEN RETURN NULL; END IF;
  UPDATE accounts
     SET suite_number = NULL,
         -- the address the Operating Agreement prints must not keep pointing at a number another company will hold
         physical_address = CASE WHEN v_addr = _largo_address_for_suite(v_suite) THEN NULL ELSE v_addr END
   WHERE id = p_account;
  PERFORM _suite_to_pool(v_suite, p_account, COALESCE(p_reason, 'company ' || v_status), p_actor);
  RETURN v_suite;
END $$;

CREATE OR REPLACE FUNCTION public.release_company_suite_if_free(p_account uuid, p_reason text DEFAULT NULL, p_actor text DEFAULT 'system')
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('app.suite_admin', 'on', true);
  v := public._release_company_suite_impl(p_account, p_reason, p_actor);
  PERFORM set_config('app.suite_admin', '', true);
  RETURN v;
END $$;

-- ─── 4. The daily sweep ─────────────────────────────────────────────────────────
--  a) every Closed / Cancelled company whose last lease has now ended;
--  b) every RESERVATION whose formation/onboarding was cancelled or deleted (several cancel paths do not call
--     release_suite_reservation themselves) — the number goes back to the pool.
-- Returns how many numbers it freed (a + b).
CREATE OR REPLACE FUNCTION public.release_ended_suites(p_actor text DEFAULT 'cron') RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT id FROM accounts WHERE status IN ('Closed', 'Cancelled') AND suite_number IS NOT NULL ORDER BY id LOOP
    IF public.release_company_suite_if_free(r.id, 'lease ended / company closed', p_actor) IS NOT NULL THEN n := n + 1; END IF;
  END LOOP;
  FOR r IN
    SELECT rs.delivery_id FROM suite_reservations rs LEFT JOIN service_deliveries sd ON sd.id = rs.delivery_id
    WHERE sd.id IS NULL OR sd.status IN ('cancelled', 'inactive') ORDER BY rs.reserved_at
  LOOP
    IF public.release_suite_reservation(r.delivery_id, p_actor) IS NOT NULL THEN n := n + 1; END IF;
  END LOOP;
  RETURN n;
END $$;

-- ─── 5. The rule: the moment a company becomes Closed / Cancelled with no lease in force, its suite is released ──
-- A BEFORE trigger that edits the row being saved (so it needs no second write and the company lock does not fire).
-- It is named so it fires AFTER trg_accounts_suite_guard (triggers run in name order): a save that names both status and
-- suite_number is judged by the lock first, then released. It only TRIES the allocator lock: if someone is allocating right
-- now it does nothing and the daily sweep releases it (waiting here could deadlock against an allocation on the same company).
CREATE OR REPLACE FUNCTION public.trg_accounts_suite_release_on_close() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('Closed', 'Cancelled')
     AND OLD.status IS DISTINCT FROM NEW.status
     AND OLD.suite_number IS NOT NULL
     AND NEW.suite_number IS NOT DISTINCT FROM OLD.suite_number
     AND NOT td_company_has_lease_in_force(NEW.id) THEN
    IF pg_try_advisory_xact_lock(hashtext('td_suite_allocator')) THEN
      PERFORM _suite_to_pool(OLD.suite_number, NEW.id, 'company ' || NEW.status, 'trigger');
      IF NEW.physical_address = _largo_address_for_suite(OLD.suite_number) THEN
        NEW.physical_address := NULL;
      END IF;
      NEW.suite_number := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_accounts_release_suite_on_close ON public.accounts;   -- old name (fired before the lock)
DROP TRIGGER IF EXISTS trg_accounts_suite_release_on_close ON public.accounts;
CREATE TRIGGER trg_accounts_suite_release_on_close
  BEFORE UPDATE OF status ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.trg_accounts_suite_release_on_close();
DROP FUNCTION IF EXISTS public.trg_accounts_release_suite_on_close();

-- ─── 6. Who may call what ────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._release_company_suite_impl(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.td_company_has_lease_in_force(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_company_suite_if_free(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_ended_suites(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_accounts_suite_release_on_close() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._suite_to_pool(text, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._largo_address_for_suite(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_company_suite_if_free(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_ended_suites(text) TO service_role;

COMMIT;
