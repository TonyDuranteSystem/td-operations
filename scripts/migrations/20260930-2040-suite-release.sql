-- Suite release (Antonio 2026-09-30): "as soon as available" — a suite goes back to the pool and is given to the next
-- new company, oldest released number first, the moment BOTH are true:
--     1) the company is Closed or Cancelled  (never Suspended / Offboarding / Delinquent / Pending Formation — those
--        can come back, and a returning company would find its number given away);
--     2) it has NO lease in force — a lease that went to the client (sent / viewed / signed) whose term has not ended.
--        Otherwise two companies would hold a lease on the same suite until the old one ends. Delete the old lease
--        (owner-only "Delete lease") or wait for its term to end; the number is released automatically at that point.
--
-- Run AFTER 20260930-2000-suite-lock.sql (which has the suite_pool table and the allocator that takes from it first).
-- NOT run by the repair: companies that are closed TODAY keep the suite on their lease record (SupraEmerge's signed
-- lease runs to 2026-12-31, so its number is released on 2027-01-01 by the daily sweep, or earlier if you delete the lease).
-- Enforced by the DATABASE so no writer of accounts.status can miss it; the daily sweep covers a lease ending later and a
-- busy moment. Safe to re-run.

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

-- ─── 2. Release one company's suite to the pool (only when it is truly free) ─────────────────────────────
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
         physical_address = CASE WHEN v_addr = '10225 Ulmerton Rd, Suite ' || v_suite || ', Largo, FL 33771' THEN NULL ELSE v_addr END
   WHERE id = p_account;
  INSERT INTO suite_pool (suite_number, released_from_account, reason)
    VALUES (v_suite, p_account, COALESCE(p_reason, 'company ' || v_status)) ON CONFLICT (suite_number) DO NOTHING;
  INSERT INTO suite_audit_log (suite_number, account_id, action, old_suite, reason, actor)
    VALUES (v_suite, p_account, 'released_to_pool', v_suite, COALESCE(p_reason, 'company ' || v_status), p_actor);
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

-- ─── 3. The daily sweep: every Closed / Cancelled company whose last lease has now ended ─────────────────
CREATE OR REPLACE FUNCTION public.release_ended_suites(p_actor text DEFAULT 'cron') RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT id FROM accounts WHERE status IN ('Closed', 'Cancelled') AND suite_number IS NOT NULL ORDER BY id LOOP
    IF public.release_company_suite_if_free(r.id, 'lease ended / company closed', p_actor) IS NOT NULL THEN n := n + 1; END IF;
  END LOOP;
  RETURN n;
END $$;

-- ─── 4. The rule: the moment a company becomes Closed / Cancelled with no lease in force, its suite is released ──
-- A BEFORE trigger that edits the row being saved (so it needs no second write and the company lock does not fire).
-- It only TRIES the allocator lock: if someone is allocating right now it does nothing and the daily sweep releases it
-- (waiting here could deadlock against an allocation on the same company).
CREATE OR REPLACE FUNCTION public.trg_accounts_release_suite_on_close() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('Closed', 'Cancelled')
     AND OLD.status IS DISTINCT FROM NEW.status
     AND OLD.suite_number IS NOT NULL
     AND NEW.suite_number IS NOT DISTINCT FROM OLD.suite_number
     AND NOT td_company_has_lease_in_force(NEW.id) THEN
    IF pg_try_advisory_xact_lock(hashtext('td_suite_allocator')) THEN
      INSERT INTO suite_pool (suite_number, released_from_account, reason)
        VALUES (OLD.suite_number, NEW.id, 'company ' || NEW.status) ON CONFLICT (suite_number) DO NOTHING;
      INSERT INTO suite_audit_log (suite_number, account_id, action, old_suite, reason, actor)
        VALUES (OLD.suite_number, NEW.id, 'released_to_pool', OLD.suite_number, 'company ' || NEW.status, 'trigger');
      IF NEW.physical_address = '10225 Ulmerton Rd, Suite ' || OLD.suite_number || ', Largo, FL 33771' THEN
        NEW.physical_address := NULL;
      END IF;
      NEW.suite_number := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_accounts_release_suite_on_close ON public.accounts;
CREATE TRIGGER trg_accounts_release_suite_on_close
  BEFORE UPDATE OF status ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.trg_accounts_release_suite_on_close();

-- ─── 5. Deleting the last lease of a closed company frees its number at once ─────────────────────────────
-- (replaces the wrapper from 20260930-2000; same behaviour plus the release)
CREATE OR REPLACE FUNCTION public.admin_delete_lease(p_lease_id uuid, p_reason text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb; v_released text;
BEGIN
  PERFORM set_config('app.suite_admin', 'on', true);
  v := public._admin_delete_lease_impl(p_lease_id, p_reason, p_actor);
  v_released := public._release_company_suite_impl((v->>'account_id')::uuid, 'last lease deleted on a closed company', p_actor);
  PERFORM set_config('app.suite_admin', '', true);
  RETURN v || jsonb_build_object('suite_released_to_pool', v_released);
END $$;

-- ─── 6. Who may call what ────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._release_company_suite_impl(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.td_company_has_lease_in_force(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_company_suite_if_free(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_ended_suites(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_accounts_release_suite_on_close() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_delete_lease(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_company_suite_if_free(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_ended_suites(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_delete_lease(uuid, text, text) TO service_role;
