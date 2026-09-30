-- Suite lock — RUN AFTER THE CODE IS DEPLOYED AND 20260930-2010 HAS RUN.
-- Two things that must wait for the new code:
--   1) the shared Principal Office row stops printing ONE company's suite;
--   2) the one-time "copy the suite from the company's own lease" door in the company lock is closed.
-- Safe to re-run.

BEGIN;

-- ─── 1. The shared Principal Office row printed ONE company's suite ("Suite 3D-205") for ~186 companies ─
-- It is our Largo office, shared by everyone: the address is "10225 Ulmerton Rd, 3D" and each company's own
-- suite is overlaid from the company (portal, invoices, EIN application, AI client card). Do this only AFTER
-- the new code is live — the old code prints the row as stored, so every company would show a bare "3D".
UPDATE addresses SET address_line2 = '3D', updated_at = now()
WHERE id = '4706c595-f96e-4031-b44e-b83d0fb80251'
  AND is_td_provided = true
  AND address_line2 = 'Suite 3D-205';

-- ─── 2. Close the one-time load door ─────────────────────────────────────────────────────────
-- Until now a company's suite could ALSO appear by copying one it already held on its own lease (that is how
-- step 5a of the repair loads them). Now that every company is loaded, the only ways a suite can appear are the
-- allocator and the logged admin functions.
CREATE OR REPLACE FUNCTION public.trg_accounts_suite_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_admin boolean := COALESCE(current_setting('app.suite_admin', true), '') = 'on';
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
  IF NOT v_admin AND (TG_OP = 'INSERT' OR OLD.suite_number IS DISTINCT FROM NEW.suite_number) THEN
    RAISE EXCEPTION 'Suite % cannot be set by hand — suites are issued by the system.', NEW.suite_number
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
