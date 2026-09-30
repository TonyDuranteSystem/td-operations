-- Suite step (Antonio 2026-09-30): issuing a company's suite is an EXPLICIT, REQUIRED step in the Formation and
-- Onboarding workspaces — staff press "Issue suite", or tick "No suite for this client" (with a reason).
--
-- What this file adds (run AFTER 20260930-2000-suite-lock.sql; safe to re-run):
--   * a waiver flag on the delivery (service_deliveries.suite_waived_*) — a fact the gate can read, not a log row;
--   * suite_step_state / issue_delivery_suite / waive_delivery_suite / unwaive_delivery_suite — the workspace buttons;
--   * claim_company_suite — materialization CLAIMS a reservation, it never issues;
--   * a database rule on service_deliveries: a Company Formation cannot move past "Wizard Submitted", and a Client
--     Onboarding cannot move past "Review & CRM Setup", until the suite is issued / reserved / waived — so no path
--     (stepper, buttons, MCP, routes, SQL) can skip the step. Test deliveries (is_test) are exempt.
-- Deliveries already past those stages are untouched (the rule only fires when a case CROSSES the gate).

-- ─── 1. The waiver flag ──────────────────────────────────────────────────────
ALTER TABLE public.service_deliveries
  ADD COLUMN IF NOT EXISTS suite_waived_at     timestamptz,
  ADD COLUMN IF NOT EXISTS suite_waived_by     text,
  ADD COLUMN IF NOT EXISTS suite_waived_reason text;

-- ─── 2. Current state of the step for one delivery ───────────────────────────
CREATE OR REPLACE FUNCTION public.suite_step_state(p_delivery uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'delivery_id',   sd.id,
    'account_id',    sd.account_id,
    'account_suite', a.suite_number,
    'reserved_suite', (SELECT r.suite_number FROM public.suite_reservations r WHERE r.delivery_id = sd.id),
    'waived',        sd.suite_waived_at IS NOT NULL,
    'waived_at',     sd.suite_waived_at,
    'waived_by',     sd.suite_waived_by,
    'waived_reason', sd.suite_waived_reason,
    'satisfied',     (a.suite_number IS NOT NULL
                      OR EXISTS (SELECT 1 FROM public.suite_reservations r WHERE r.delivery_id = sd.id)
                      OR sd.suite_waived_at IS NOT NULL)
  )
  FROM public.service_deliveries sd
  LEFT JOIN public.accounts a ON a.id = sd.account_id
  WHERE sd.id = p_delivery
$$;

-- ─── 3. "Issue suite": clears a waiver, then the allocator (company if it exists, else reserve on the delivery) ─
CREATE OR REPLACE FUNCTION public.issue_delivery_suite(p_delivery uuid, p_actor text DEFAULT 'system') RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_acc uuid; v_cleared integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('td_suite_allocator'));
  SELECT account_id INTO v_acc FROM public.service_deliveries WHERE id = p_delivery FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'delivery % not found', p_delivery; END IF;
  UPDATE public.service_deliveries
     SET suite_waived_at = NULL, suite_waived_by = NULL, suite_waived_reason = NULL
   WHERE id = p_delivery AND suite_waived_at IS NOT NULL;
  GET DIAGNOSTICS v_cleared = ROW_COUNT;
  IF v_cleared > 0 THEN
    INSERT INTO public.suite_audit_log (account_id, delivery_id, action, reason, actor)
      VALUES (v_acc, p_delivery, 'waiver_removed', 'suite issued', p_actor);
  END IF;
  RETURN public.allocate_company_suite(v_acc, p_delivery, p_actor);
END $$;

-- ─── 4. "No suite for this client": needs a reason; frees any reservation; refused if a suite already exists ──
CREATE OR REPLACE FUNCTION public.waive_delivery_suite(p_delivery uuid, p_reason text, p_actor text DEFAULT 'system') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_acc uuid; v_suite text; v_released text;
BEGIN
  IF COALESCE(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('td_suite_allocator'));
  SELECT account_id INTO v_acc FROM public.service_deliveries WHERE id = p_delivery FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'delivery % not found', p_delivery; END IF;
  IF v_acc IS NOT NULL THEN
    SELECT suite_number INTO v_suite FROM public.accounts WHERE id = v_acc;
    IF v_suite IS NOT NULL THEN
      RAISE EXCEPTION 'This company already has suite % — there is nothing to waive.', v_suite;
    END IF;
  END IF;
  v_released := public.release_suite_reservation(p_delivery, p_actor);
  UPDATE public.service_deliveries
     SET suite_waived_at = now(), suite_waived_by = p_actor, suite_waived_reason = btrim(p_reason)
   WHERE id = p_delivery;
  INSERT INTO public.suite_audit_log (account_id, delivery_id, action, reason, actor, detail)
    VALUES (v_acc, p_delivery, 'waived', btrim(p_reason), p_actor, jsonb_build_object('released_reservation', v_released));
  RETURN jsonb_build_object('waived', true, 'released_reservation', v_released);
END $$;

CREATE OR REPLACE FUNCTION public.unwaive_delivery_suite(p_delivery uuid, p_actor text DEFAULT 'system') RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_acc uuid; v_cleared integer;
BEGIN
  SELECT account_id INTO v_acc FROM public.service_deliveries WHERE id = p_delivery FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'delivery % not found', p_delivery; END IF;
  UPDATE public.service_deliveries
     SET suite_waived_at = NULL, suite_waived_by = NULL, suite_waived_reason = NULL
   WHERE id = p_delivery AND suite_waived_at IS NOT NULL;
  GET DIAGNOSTICS v_cleared = ROW_COUNT;
  IF v_cleared > 0 THEN
    INSERT INTO public.suite_audit_log (account_id, delivery_id, action, reason, actor)
      VALUES (v_acc, p_delivery, 'waiver_removed', 'waiver removed', p_actor);
  END IF;
  RETURN v_cleared > 0;
END $$;

-- ─── 5. CLAIM ONLY (materialization): move a reservation onto the company; NEVER issues a new number ─────────
CREATE OR REPLACE FUNCTION public._claim_company_suite_impl(p_account uuid, p_delivery uuid, p_actor text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_suite text; v_res text; v_del uuid := p_delivery;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('td_suite_allocator'));
  SELECT suite_number INTO v_suite FROM accounts WHERE id = p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'account % not found', p_account; END IF;
  IF v_suite IS NOT NULL THEN RETURN v_suite; END IF;
  IF p_delivery IS NOT NULL THEN
    SELECT suite_number INTO v_res FROM suite_reservations WHERE delivery_id = p_delivery;
  END IF;
  IF v_res IS NULL THEN
    SELECT r.suite_number, r.delivery_id INTO v_res, v_del
    FROM suite_reservations r JOIN service_deliveries sd ON sd.id = r.delivery_id
    WHERE sd.account_id = p_account ORDER BY r.reserved_at LIMIT 1;
  END IF;
  IF v_res IS NULL THEN RETURN NULL; END IF;
  DELETE FROM suite_reservations WHERE delivery_id = v_del;
  UPDATE accounts SET suite_number = v_res WHERE id = p_account;
  INSERT INTO suite_audit_log (suite_number, account_id, delivery_id, action, new_suite, actor)
    VALUES (v_res, p_account, v_del, 'claimed', v_res, p_actor);
  RETURN v_res;
END $$;

CREATE OR REPLACE FUNCTION public.claim_company_suite(p_account uuid, p_delivery uuid DEFAULT NULL, p_actor text DEFAULT 'system')
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('app.suite_admin', 'on', true);
  v := public._claim_company_suite_impl(p_account, p_delivery, p_actor);
  PERFORM set_config('app.suite_admin', '', true);
  RETURN v;
END $$;

-- ─── 6. The rule: no path may move a case past the gate without the suite decision ────────────────────────
CREATE OR REPLACE FUNCTION public.trg_delivery_suite_step_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_gate_name text; v_gate_order integer; v_ok boolean;
BEGIN
  IF NEW.service_type NOT IN ('Company Formation', 'Client Onboarding') THEN RETURN NEW; END IF;
  IF COALESCE(NEW.is_test, false) THEN RETURN NEW; END IF;
  IF NEW.stage_order IS NULL OR OLD.stage_order IS NULL OR NEW.stage_order <= OLD.stage_order THEN RETURN NEW; END IF;
  v_gate_name := CASE NEW.service_type WHEN 'Company Formation' THEN 'Wizard Submitted' ELSE 'Review & CRM Setup' END;
  SELECT stage_order INTO v_gate_order FROM pipeline_stages
   WHERE service_type = NEW.service_type AND stage_name = v_gate_name LIMIT 1;
  IF v_gate_order IS NULL OR OLD.stage_order > v_gate_order OR NEW.stage_order <= v_gate_order THEN RETURN NEW; END IF;
  SELECT (a.suite_number IS NOT NULL
          OR EXISTS (SELECT 1 FROM suite_reservations r WHERE r.delivery_id = NEW.id)
          OR NEW.suite_waived_at IS NOT NULL)
    INTO v_ok
    FROM (SELECT NEW.account_id AS account_id) x LEFT JOIN accounts a ON a.id = x.account_id;
  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'Issue the company''s suite (or tick "No suite for this client") before moving this case past "%".', v_gate_name
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_delivery_suite_step_guard ON public.service_deliveries;
CREATE TRIGGER trg_delivery_suite_step_guard
  BEFORE UPDATE OF stage_order ON public.service_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.trg_delivery_suite_step_guard();

-- ─── 7. Who may call what ────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._claim_company_suite_impl(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.suite_step_state(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.issue_delivery_suite(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.waive_delivery_suite(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unwaive_delivery_suite(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_company_suite(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_delivery_suite_step_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.suite_step_state(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.issue_delivery_suite(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.waive_delivery_suite(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.unwaive_delivery_suite(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_company_suite(uuid, uuid, text) TO service_role;
