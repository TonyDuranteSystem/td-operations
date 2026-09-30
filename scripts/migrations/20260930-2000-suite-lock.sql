-- Suite lock (Antonio 2026-09-30): one suite per company, issued once, locked by the DATABASE.
--
-- Rules this file enforces:
--   * a company has at most ONE suite (accounts.suite_number) and a suite belongs to at most ONE
--     company (unique index);
--   * the ONLY ways a suite appears on a company are: the allocator (next free number, under a
--     lock so two callers never get the same one), "place an existing client" (explicit, logged),
--     or copying a suite the company ALREADY holds on its own lease (the one-time data load);
--   * once assigned a suite cannot change or be removed, except through the logged admin
--     functions below (service role only);
--   * a lease's suite must be its company's suite, and its tenant must be the company itself
--     (never a person) — signed leases can't change suite, and viewed/signed leases can't be
--     deleted except through the logged admin function;
--   * a formation client has no company row yet — its suite is RESERVED on the delivery and moved
--     onto the company when it is created (or released back to the pool if the delivery is cancelled /
--     the suite is waived). A number is handed out again only from the pool of RELEASED numbers —
--     see 20260930-2040-suite-release.sql (closed / cancelled company with no lease in force).
--
-- Run 20260930-1900-accounts-suite-number.sql first.
-- SAFE TO RE-RUN: every function/trigger in this file is the FINAL definition (later files only ADD objects — none of
-- them redefines anything here), so running this file again never undoes a later file.
-- PRODUCTION ORDER: see the header of 20260930-2010-suite-lock-data-repair.sql (2000 and 2010 back to back, then deploy).

-- ─── 1. Tables ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.suite_reservations (
  suite_number text PRIMARY KEY CHECK (suite_number ~ '^3D-[0-9]{3,4}$'),
  delivery_id  uuid NOT NULL UNIQUE,
  reserved_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.suite_audit_log (
  id           bigserial PRIMARY KEY,
  suite_number text,
  account_id   uuid,
  delivery_id  uuid,
  action       text NOT NULL,
  old_suite    text,
  new_suite    text,
  reason       text,
  actor        text,
  detail       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_suite_audit_log_account ON public.suite_audit_log (account_id);

-- Numbers released by a closed company (or a cancelled/waived reservation) and free to hand out again — oldest first.
-- Nothing is ever put here by the code paths of Part 1; the release rule (20260930-2040) and the reservation release do.
CREATE TABLE IF NOT EXISTS public.suite_pool (
  suite_number          text PRIMARY KEY CHECK (suite_number ~ '^3D-[0-9]{3,4}$'),
  released_at           timestamptz NOT NULL DEFAULT now(),
  released_from_account uuid,
  reason                text
);

ALTER TABLE public.suite_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suite_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suite_audit_log ENABLE ROW LEVEL SECURITY;

-- ─── 2. One company per suite ────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_suite_number
  ON public.accounts (suite_number) WHERE suite_number IS NOT NULL;

-- ─── 3. Helpers ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.td_suite_num(p text) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT NULLIF(substring(p from '^3D-([0-9]{1,9})$'), '')::integer $$;

-- The next free suite: one above the highest number EVER used anywhere (companies, leases,
-- reservations, audit log), floor 100. Caller must hold the allocator lock.
CREATE OR REPLACE FUNCTION public.td_next_suite() RETURNS text
LANGUAGE sql AS $$
  SELECT '3D-' || lpad((GREATEST(100, COALESCE(max(n), 0)) + 1)::text, 3, '0')
  FROM (
    SELECT td_suite_num(suite_number) AS n FROM public.accounts
    UNION ALL SELECT td_suite_num(suite_number) FROM public.lease_agreements
    UNION ALL SELECT td_suite_num(suite_number) FROM public.suite_reservations
    UNION ALL SELECT td_suite_num(suite_number) FROM public.suite_audit_log
    UNION ALL SELECT td_suite_num(old_suite) FROM public.suite_audit_log
    UNION ALL SELECT td_suite_num(new_suite) FROM public.suite_audit_log
  ) s
$$;

-- True when this suite must NOT be handed to p_account by hand: it was issued/used for a DIFFERENT company, a
-- released reservation, or sits on another company's lease — UNLESS it is in the pool of released numbers (free).
-- (A company may always get its own old suite back.)
CREATE OR REPLACE FUNCTION public.td_suite_history_blocks(p_suite text, p_account uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.suite_pool WHERE suite_number = p_suite)
     AND (
       EXISTS (
         SELECT 1 FROM public.suite_audit_log
         WHERE (suite_number = p_suite OR old_suite = p_suite OR new_suite = p_suite)
           AND ((account_id IS NOT NULL AND account_id IS DISTINCT FROM p_account) OR action = 'reservation_released'))
       OR EXISTS (SELECT 1 FROM public.lease_agreements WHERE suite_number = p_suite AND account_id IS DISTINCT FROM p_account)
     )
$$;

-- ─── 4. The allocator (the ONLY place a new number is created) ───────────────
-- Give it a company (account_id) and/or the delivery it comes from.
--  * company already has a suite  -> returns it (and drops a stale reservation);
--  * a reservation exists for the delivery -> moves it onto the company (or returns it);
--  * otherwise issues the next free number: on the company if it exists, else reserved on the delivery.
CREATE OR REPLACE FUNCTION public._allocate_company_suite_impl(
  p_account_id uuid DEFAULT NULL, p_delivery_id uuid DEFAULT NULL, p_actor text DEFAULT 'system'
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_suite text; v_res text; v_del uuid := p_delivery_id;
BEGIN
  IF p_account_id IS NULL AND p_delivery_id IS NULL THEN
    RAISE EXCEPTION 'allocate_company_suite needs an account or a delivery';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('td_suite_allocator'));

  IF p_account_id IS NOT NULL THEN
    SELECT suite_number INTO v_suite FROM accounts WHERE id = p_account_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'account % not found', p_account_id; END IF;
    IF v_suite IS NOT NULL THEN
      IF p_delivery_id IS NOT NULL THEN DELETE FROM suite_reservations WHERE delivery_id = p_delivery_id; END IF;
      RETURN v_suite;
    END IF;
  END IF;

  -- 1. the reservation the caller named
  IF p_delivery_id IS NOT NULL THEN
    SELECT suite_number INTO v_res FROM suite_reservations WHERE delivery_id = p_delivery_id;
  END IF;
  -- 2. a retry / a later caller that does not know the delivery: find the reservation of a formation
  --    delivery that is already linked to this company (materialization links it before the suite step)
  IF v_res IS NULL AND p_account_id IS NOT NULL THEN
    SELECT r.suite_number, r.delivery_id INTO v_res, v_del
    FROM suite_reservations r JOIN service_deliveries sd ON sd.id = r.delivery_id
    WHERE sd.account_id = p_account_id ORDER BY r.reserved_at LIMIT 1;
  END IF;

  IF v_res IS NOT NULL THEN
    IF p_account_id IS NULL THEN RETURN v_res; END IF;
    DELETE FROM suite_reservations WHERE delivery_id = v_del;
    UPDATE accounts SET suite_number = v_res WHERE id = p_account_id;
    INSERT INTO suite_audit_log (suite_number, account_id, delivery_id, action, new_suite, actor)
      VALUES (v_res, p_account_id, v_del, 'claimed', v_res, p_actor);
    RETURN v_res;
  END IF;

  -- 3. a company that already holds a suite on its OWN lease (legacy company, not loaded yet) ADOPTS it —
  --    never issued a second, different number. A suite that appears on another company's lease/account,
  --    or is reserved, is never adopted (the two known shared suites stay out until a human repairs them).
  IF p_account_id IS NOT NULL THEN
    SELECT ls.suite_number INTO v_suite
    FROM lease_agreements ls JOIN accounts ac ON ac.id = ls.account_id
    WHERE ls.account_id = p_account_id
      AND lower(btrim(ls.tenant_company)) = lower(btrim(ac.company_name))
      AND ls.suite_number ~ '^3D-[0-9]{3,4}$'
      AND NOT EXISTS (SELECT 1 FROM lease_agreements l2 WHERE l2.suite_number = ls.suite_number AND l2.account_id <> p_account_id)
      AND NOT EXISTS (SELECT 1 FROM accounts a2 WHERE a2.suite_number = ls.suite_number AND a2.id <> p_account_id)
      AND NOT EXISTS (SELECT 1 FROM suite_reservations r2 WHERE r2.suite_number = ls.suite_number)
    ORDER BY ls.created_at ASC LIMIT 1;
    IF v_suite IS NOT NULL THEN
      UPDATE accounts SET suite_number = v_suite WHERE id = p_account_id;
      INSERT INTO suite_audit_log (suite_number, account_id, delivery_id, action, new_suite, actor)
        VALUES (v_suite, p_account_id, p_delivery_id, 'adopted_from_lease', v_suite, p_actor);
      RETURN v_suite;
    END IF;
  END IF;

  -- 4. otherwise issue: the OLDEST released number from the pool first, else the next new number
  -- (a pool row for a number that is held by a company or reserved is stale — drop it, never hand it out)
  DELETE FROM suite_pool p
   WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.suite_number = p.suite_number)
      OR EXISTS (SELECT 1 FROM suite_reservations r WHERE r.suite_number = p.suite_number);
  SELECT suite_number INTO v_suite FROM suite_pool ORDER BY released_at, suite_number LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF v_suite IS NOT NULL THEN
    DELETE FROM suite_pool WHERE suite_number = v_suite;
  ELSE
    v_suite := td_next_suite();
  END IF;
  IF p_account_id IS NOT NULL THEN
    UPDATE accounts SET suite_number = v_suite WHERE id = p_account_id;
  ELSE
    INSERT INTO suite_reservations (suite_number, delivery_id) VALUES (v_suite, p_delivery_id);
  END IF;
  INSERT INTO suite_audit_log (suite_number, account_id, delivery_id, action, new_suite, actor)
    VALUES (v_suite, p_account_id, p_delivery_id,
            CASE WHEN p_account_id IS NULL THEN 'reserved' ELSE 'assigned' END, v_suite, p_actor);
  RETURN v_suite;
END $$;

-- A formation/onboarding that never produced a company (or whose suite was waived): free the reservation. The
-- number goes back to the pool of released numbers and is handed out again, oldest first.
CREATE OR REPLACE FUNCTION public.release_suite_reservation(p_delivery_id uuid, p_actor text DEFAULT 'system')
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_suite text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('td_suite_allocator'));
  DELETE FROM suite_reservations WHERE delivery_id = p_delivery_id RETURNING suite_number INTO v_suite;
  IF v_suite IS NOT NULL THEN
    INSERT INTO suite_audit_log (suite_number, delivery_id, action, old_suite, reason, actor)
      VALUES (v_suite, p_delivery_id, 'reservation_released', v_suite, 'delivery cancelled or waived', p_actor);
    -- a reserved number was never given to a company: it goes straight back to the pool
    INSERT INTO suite_pool (suite_number, released_from_account, reason)
      VALUES (v_suite, NULL, 'reservation released') ON CONFLICT (suite_number) DO NOTHING;
  END IF;
  RETURN v_suite;
END $$;

-- Place an EXISTING client that already has a known suite (explicit, logged). Refuses a suite
-- held by another company / reservation, or a company that already has a different suite.
CREATE OR REPLACE FUNCTION public._assign_specific_company_suite_impl(p_account_id uuid, p_suite text, p_actor text DEFAULT 'system')
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cur text;
BEGIN
  IF p_suite IS NULL OR p_suite !~ '^3D-[0-9]{3,4}$' THEN
    RAISE EXCEPTION 'Invalid suite "%": must look like 3D-318', p_suite;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('td_suite_allocator'));
  SELECT suite_number INTO v_cur FROM accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'account % not found', p_account_id; END IF;
  IF v_cur = p_suite THEN RETURN v_cur; END IF;
  IF v_cur IS NOT NULL THEN
    RAISE EXCEPTION 'This company already has suite % — it is locked. Use the admin change.', v_cur;
  END IF;
  IF EXISTS (SELECT 1 FROM accounts WHERE suite_number = p_suite AND id <> p_account_id)
     OR EXISTS (SELECT 1 FROM suite_reservations WHERE suite_number = p_suite) THEN
    RAISE EXCEPTION 'Suite % already belongs to another company', p_suite;
  END IF;
  IF td_suite_history_blocks(p_suite, p_account_id) THEN
    RAISE EXCEPTION 'Suite % was already used by another company (or released) — this number is not free: it becomes available only when that company is closed / cancelled and its lease has ended', p_suite;
  END IF;
  UPDATE accounts SET suite_number = p_suite WHERE id = p_account_id;
  DELETE FROM suite_pool WHERE suite_number = p_suite;
  INSERT INTO suite_audit_log (suite_number, account_id, action, new_suite, actor)
    VALUES (p_suite, p_account_id, 'assigned_specific', p_suite, p_actor);
  RETURN p_suite;
END $$;

-- ─── 5. Admin functions: the ONLY way to change or remove a locked suite / lease ─────────────
-- p_new_suite NULL = take the suite off the company (refused while it has any lease).
-- Draft/sent/viewed leases of the company follow the new suite; SIGNED leases are left alone and
-- reported so the caller deletes + reissues them (admin_delete_lease).
CREATE OR REPLACE FUNCTION public._admin_change_company_suite_impl(
  p_account_id uuid, p_new_suite text, p_reason text, p_actor text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_old text; v_signed integer; v_moved integer := 0;
BEGIN
  IF COALESCE(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
  IF p_new_suite IS NOT NULL AND p_new_suite !~ '^3D-[0-9]{3,4}$' THEN
    RAISE EXCEPTION 'Invalid suite "%": must look like 3D-318', p_new_suite;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('td_suite_allocator'));
  SELECT suite_number INTO v_old FROM accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'account % not found', p_account_id; END IF;
  IF p_new_suite IS NOT DISTINCT FROM v_old THEN
    RETURN jsonb_build_object('changed', false, 'suite', v_old);
  END IF;
  IF p_new_suite IS NULL AND EXISTS (SELECT 1 FROM lease_agreements WHERE account_id = p_account_id) THEN
    RAISE EXCEPTION 'This company still has lease(s) — delete them first (admin delete), then the suite can be taken off.';
  END IF;
  IF p_new_suite IS NOT NULL AND (
       EXISTS (SELECT 1 FROM accounts WHERE suite_number = p_new_suite AND id <> p_account_id)
       OR EXISTS (SELECT 1 FROM suite_reservations WHERE suite_number = p_new_suite)) THEN
    RAISE EXCEPTION 'Suite % already belongs to another company', p_new_suite;
  END IF;
  IF p_new_suite IS NOT NULL AND td_suite_history_blocks(p_new_suite, p_account_id) THEN
    RAISE EXCEPTION 'Suite % was already used by another company (or released) — this number is not free: it becomes available only when that company is closed / cancelled and its lease has ended', p_new_suite;
  END IF;
  UPDATE accounts SET suite_number = p_new_suite WHERE id = p_account_id;
  IF p_new_suite IS NOT NULL THEN
    DELETE FROM suite_pool WHERE suite_number = p_new_suite;
    UPDATE lease_agreements SET suite_number = p_new_suite
      WHERE account_id = p_account_id AND status <> 'signed';
    GET DIAGNOSTICS v_moved = ROW_COUNT;
  END IF;
  SELECT count(*) INTO v_signed FROM lease_agreements
    WHERE account_id = p_account_id AND status = 'signed' AND suite_number IS DISTINCT FROM p_new_suite;
  INSERT INTO suite_audit_log (suite_number, account_id, action, old_suite, new_suite, reason, actor, detail)
    VALUES (COALESCE(p_new_suite, v_old), p_account_id, 'admin_change', v_old, p_new_suite, p_reason, p_actor,
            jsonb_build_object('unsigned_leases_moved', v_moved, 'signed_leases_left', v_signed));
  RETURN jsonb_build_object('changed', true, 'old', v_old, 'new', p_new_suite,
                            'unsigned_leases_moved', v_moved, 'signed_leases_to_replace', v_signed);
END $$;

-- Delete a lease (any status), keeping a full copy in the audit log.
CREATE OR REPLACE FUNCTION public._admin_delete_lease_impl(p_lease_id uuid, p_reason text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row lease_agreements%ROWTYPE;
BEGIN
  IF COALESCE(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
  SELECT * INTO v_row FROM lease_agreements WHERE id = p_lease_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lease % not found', p_lease_id; END IF;
  INSERT INTO suite_audit_log (suite_number, account_id, action, old_suite, reason, actor, detail)
    VALUES (v_row.suite_number, v_row.account_id, 'lease_deleted', v_row.suite_number, p_reason, p_actor, to_jsonb(v_row));
  DELETE FROM lease_agreements WHERE id = p_lease_id;
  RETURN jsonb_build_object('deleted', true, 'status', v_row.status, 'suite', v_row.suite_number,
                            'account_id', v_row.account_id, 'token', v_row.token);
END $$;

-- ─── 5b. Public entry points: turn "admin mode" on ONLY while the function runs ───────────────
-- (the triggers below let these functions through and nothing else). The mode is transaction-local
-- and switched off again before returning, so a later statement in the same transaction is guarded.
CREATE OR REPLACE FUNCTION public.allocate_company_suite(
  p_account_id uuid DEFAULT NULL, p_delivery_id uuid DEFAULT NULL, p_actor text DEFAULT 'system'
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('app.suite_admin', 'on', true);
  v := public._allocate_company_suite_impl(p_account_id, p_delivery_id, p_actor);
  PERFORM set_config('app.suite_admin', '', true);
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.assign_specific_company_suite(p_account_id uuid, p_suite text, p_actor text DEFAULT 'system')
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('app.suite_admin', 'on', true);
  v := public._assign_specific_company_suite_impl(p_account_id, p_suite, p_actor);
  PERFORM set_config('app.suite_admin', '', true);
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.admin_change_company_suite(p_account_id uuid, p_new_suite text, p_reason text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('app.suite_admin', 'on', true);
  v := public._admin_change_company_suite_impl(p_account_id, p_new_suite, p_reason, p_actor);
  PERFORM set_config('app.suite_admin', '', true);
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.admin_delete_lease(p_lease_id uuid, p_reason text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb; v_released text;
BEGIN
  PERFORM set_config('app.suite_admin', 'on', true);
  v := public._admin_delete_lease_impl(p_lease_id, p_reason, p_actor);
  -- deleting the last lease of a Closed / Cancelled company frees its number at once (function defined in 20260930-2040;
  -- skipped until that file has run)
  IF to_regprocedure('public._release_company_suite_impl(uuid,text,text)') IS NOT NULL THEN
    v_released := public._release_company_suite_impl((v->>'account_id')::uuid, 'last lease deleted on a closed company', p_actor);
  END IF;
  PERFORM set_config('app.suite_admin', '', true);
  RETURN v || jsonb_build_object('suite_released_to_pool', v_released);
END $$;

-- the working functions are reachable ONLY through the wrappers above (which turn admin mode on)
REVOKE ALL ON FUNCTION public._allocate_company_suite_impl(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._assign_specific_company_suite_impl(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._admin_change_company_suite_impl(uuid, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._admin_delete_lease_impl(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.td_suite_num(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.td_next_suite() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.td_suite_history_blocks(text, uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.allocate_company_suite(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_suite_reservation(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_specific_company_suite(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_change_company_suite(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_delete_lease(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_company_suite(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_suite_reservation(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.assign_specific_company_suite(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_change_company_suite(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_delete_lease(uuid, text, text) TO service_role;

-- ─── 6. The lock on accounts.suite_number ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_accounts_suite_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_admin boolean := COALESCE(current_setting('app.suite_admin', true), '') = 'on';
        v_load  boolean := COALESCE(current_setting('app.suite_load', true), '') = 'on';
BEGIN
  IF NEW.suite_number IS NULL THEN
    IF TG_OP = 'UPDATE' AND OLD.suite_number IS NOT NULL AND NOT v_admin THEN
      RAISE EXCEPTION 'Suite % is locked — it cannot be removed. Use the admin change.', OLD.suite_number
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.suite_number !~ '^3D-[0-9]{3,4}$' THEN
    RAISE EXCEPTION 'Invalid suite "%": must look like 3D-318', NEW.suite_number USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.suite_number IS NOT NULL
     AND NEW.suite_number IS DISTINCT FROM OLD.suite_number AND NOT v_admin THEN
    RAISE EXCEPTION 'Suite % is locked — it cannot be changed. Use the admin change.', OLD.suite_number
      USING ERRCODE = 'check_violation';
  END IF;
  -- A suite may only APPEAR on a company if it came from the allocator / admin functions. The ONE exception is the
  -- one-time data load (20260930-2010 switches app.suite_load on inside its own transaction): copying a suite the
  -- company ALREADY holds on its own lease. Otherwise a number invented by hand is refused.
  IF NOT v_admin AND (TG_OP = 'INSERT' OR OLD.suite_number IS DISTINCT FROM NEW.suite_number) THEN
    IF NOT v_load
       OR EXISTS (SELECT 1 FROM public.suite_reservations WHERE suite_number = NEW.suite_number)
       OR EXISTS (SELECT 1 FROM public.lease_agreements WHERE suite_number = NEW.suite_number AND account_id <> NEW.id)
       OR NOT EXISTS (SELECT 1 FROM public.lease_agreements WHERE suite_number = NEW.suite_number AND account_id = NEW.id) THEN
      RAISE EXCEPTION 'Suite % cannot be set by hand — suites are issued by the system.', NEW.suite_number
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_accounts_suite_guard ON public.accounts;
CREATE TRIGGER trg_accounts_suite_guard
  BEFORE INSERT OR UPDATE OF suite_number ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.trg_accounts_suite_guard();

-- ─── 7. The lock on lease_agreements ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_lease_suite_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_acc_suite text; v_acc_name text;
BEGIN
  IF COALESCE(current_setting('app.suite_admin', true), '') = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'signed' AND NEW.suite_number IS DISTINCT FROM OLD.suite_number THEN
    RAISE EXCEPTION 'This lease is signed — its suite cannot change. Delete and reissue it (admin).'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'draft' AND OLD.status IN ('sent', 'viewed', 'signed') THEN
    RAISE EXCEPTION 'A % lease cannot be set back to draft — it has already gone to the client.', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- also when a lease GOES TO / ADVANCES WITH the client: a draft written before its company's number was released (or a
  -- sent link that lapsed) must not reach the client with a suite another company may now hold.
  IF TG_OP = 'INSERT' OR NEW.suite_number IS DISTINCT FROM OLD.suite_number
     OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.tenant_company IS DISTINCT FROM OLD.tenant_company
     OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('sent', 'viewed', 'signed')) THEN
    SELECT suite_number, company_name INTO v_acc_suite, v_acc_name FROM public.accounts WHERE id = NEW.account_id;
    IF NEW.suite_number IS NOT NULL AND v_acc_suite IS DISTINCT FROM NEW.suite_number THEN
      RAISE EXCEPTION 'Lease suite % is not the company''s suite (%). A lease always uses the company''s own suite — issue the suite first, or recreate this lease.',
        NEW.suite_number, COALESCE(v_acc_suite, 'none assigned') USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.tenant_company IS NOT NULL AND v_acc_name IS NOT NULL
       AND lower(btrim(NEW.tenant_company)) <> lower(btrim(v_acc_name)) THEN
      RAISE EXCEPTION 'The tenant of a lease must be the company itself (%), never a person.', v_acc_name
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_lease_suite_guard ON public.lease_agreements;
CREATE TRIGGER trg_lease_suite_guard
  BEFORE INSERT OR UPDATE OF suite_number, account_id, tenant_company, status ON public.lease_agreements
  FOR EACH ROW EXECUTE FUNCTION public.trg_lease_suite_guard();

-- A viewed or signed lease is client-visible: it cannot be deleted by accident.
CREATE OR REPLACE FUNCTION public.trg_lease_delete_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('viewed', 'signed', 'sent')
     AND COALESCE(current_setting('app.suite_admin', true), '') <> 'on' THEN
    RAISE EXCEPTION 'A % lease can only be deleted through the admin delete (it is logged).', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_lease_delete_guard ON public.lease_agreements;
CREATE TRIGGER trg_lease_delete_guard
  BEFORE DELETE ON public.lease_agreements
  FOR EACH ROW EXECUTE FUNCTION public.trg_lease_delete_guard();

-- ─── 8. The old lease-level indexes are replaced by the company-level rules above ─────────────
-- They only covered draft/sent/active (so viewed/signed leases escaped) and would now block a
-- renewal that correctly re-uses the company's own suite.
DROP INDEX IF EXISTS public.lease_suite_active_unique;
DROP INDEX IF EXISTS public.idx_lease_suite_active;
