-- When a company is closed/cancelled and its number is released, its stored physical_address must not keep pointing at our Largo
-- office. Since 2026-10-10 the stored address is the OFFICIAL address "10225 Ulmerton Rd 3D, Largo, FL 33771" (no company number);
-- before it was "10225 Ulmerton Rd, Suite 3D-NNN, Largo, FL 33771". The release functions only recognised the old form, so a closed
-- company would have kept a numberless Largo address. Both forms are cleared now. Bodies are otherwise identical to
-- 20260930-2040-suite-release.sql (grants are unchanged by CREATE OR REPLACE).
BEGIN;

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
         -- the address the Operating Agreement prints must not keep pointing at our Largo office after the number is released
         physical_address = CASE WHEN v_addr IN (_largo_address_for_suite(v_suite), '10225 Ulmerton Rd 3D, Largo, FL 33771') THEN NULL ELSE v_addr END
   WHERE id = p_account;
  PERFORM _suite_to_pool(v_suite, p_account, COALESCE(p_reason, 'company ' || v_status), p_actor);
  RETURN v_suite;
END $$;

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
      IF NEW.physical_address IN (_largo_address_for_suite(OLD.suite_number), '10225 Ulmerton Rd 3D, Largo, FL 33771') THEN
        NEW.physical_address := NULL;
      END IF;
      NEW.suite_number := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;

COMMIT;
