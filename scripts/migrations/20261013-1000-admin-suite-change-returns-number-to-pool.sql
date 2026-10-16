-- When an owner takes a company's PMB number off (or changes it to another number) in the CRM, the number the company leaves behind
-- used to vanish: it was not put back in the pool, and the history check then blocked every other company from ever using it
-- (found 2026-10-12 in the production SS-4 test: PMB 434 was lost until it was returned by hand).
-- Now the number it leaves goes back to the pool — but ONLY when nothing still refers to it (no lease of any company carries it, no company holds it,
-- no reservation holds it). A signed lease that still shows the old number keeps it out of the pool.
-- Taking the number OFF also clears the company's stored official address when that address is our Largo office (the same thing releasing a closed
-- company's number does), so a company with no number does not keep a Largo address.
-- Body otherwise identical to the live definition (checked identical on sandbox and production, 2026-10-13); grants unchanged by CREATE OR REPLACE.
BEGIN;

CREATE OR REPLACE FUNCTION public._admin_change_company_suite_impl(p_account_id uuid, p_new_suite text, p_reason text, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_old text; v_addr text; v_signed integer; v_moved integer := 0; v_pooled boolean := false;
BEGIN
  IF COALESCE(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
  IF p_new_suite IS NOT NULL AND p_new_suite !~ '^3D-[0-9]{3,4}$' THEN
    RAISE EXCEPTION 'Invalid suite "%": must look like 3D-318', p_new_suite;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('td_suite_allocator'));
  SELECT suite_number, physical_address INTO v_old, v_addr FROM accounts WHERE id = p_account_id FOR UPDATE;
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
  UPDATE accounts
     SET suite_number = p_new_suite,
         -- taking the number off: a stored official/Largo address must not stay behind (same rule as releasing a closed company's number)
         physical_address = CASE WHEN p_new_suite IS NULL AND v_addr IN (_largo_address_for_suite(v_old), '10225 Ulmerton Rd 3D, Largo, FL 33771') THEN NULL ELSE physical_address END
   WHERE id = p_account_id;
  IF p_new_suite IS NOT NULL THEN
    DELETE FROM suite_pool WHERE suite_number = p_new_suite;
    UPDATE lease_agreements SET suite_number = p_new_suite
      WHERE account_id = p_account_id AND status <> 'signed';
    GET DIAGNOSTICS v_moved = ROW_COUNT;
  END IF;
  SELECT count(*) INTO v_signed FROM lease_agreements
    WHERE account_id = p_account_id AND status = 'signed' AND suite_number IS DISTINCT FROM p_new_suite;
  -- the number this company leaves goes back to the pool when nothing still refers to it
  IF v_old IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM lease_agreements WHERE suite_number = v_old)
     AND NOT EXISTS (SELECT 1 FROM accounts WHERE suite_number = v_old)
     AND NOT EXISTS (SELECT 1 FROM suite_reservations WHERE suite_number = v_old) THEN
    PERFORM _suite_to_pool(v_old, p_account_id, 'taken off the company by the owner: ' || p_reason, p_actor);
    v_pooled := true;
  END IF;
  INSERT INTO suite_audit_log (suite_number, account_id, action, old_suite, new_suite, reason, actor, detail)
    VALUES (COALESCE(p_new_suite, v_old), p_account_id, 'admin_change', v_old, p_new_suite, p_reason, p_actor,
            jsonb_build_object('unsigned_leases_moved', v_moved, 'signed_leases_left', v_signed, 'returned_to_pool', v_pooled));
  RETURN jsonb_build_object('changed', true, 'old', v_old, 'new', p_new_suite,
                            'unsigned_leases_moved', v_moved, 'signed_leases_to_replace', v_signed, 'returned_to_pool', v_pooled);
END $function$;

COMMIT;
