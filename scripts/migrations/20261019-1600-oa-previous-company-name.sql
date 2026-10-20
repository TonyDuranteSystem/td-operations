-- Company Change Name: the NEW Operating Agreement says "formerly known as <old name>" (Antonio, 2026-10-19; dev job bb64c417, track B4).
-- A frozen text on the agreement itself (an agreement is a snapshot — it must not follow later renames), written only when a renamed company
-- generates its new agreement. Nullable, no default: every existing agreement stays exactly as it is.
-- APPLY THIS BEFORE THE CODE THAT READS IT (the OA pages select the column; without it they fail). Instant; no table rewrite.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.oa_agreements ADD COLUMN IF NOT EXISTS previous_company_name text;
COMMENT ON COLUMN public.oa_agreements.previous_company_name IS 'The company name before a rename (Company Change Name): printed as "formerly known as ..." in the agreement. Frozen at generation.';

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'oa_agreements' AND column_name = 'previous_company_name') THEN
    RAISE EXCEPTION 'oa-previous-company-name: the column is missing after the change';
  END IF;
END
$do$;
COMMIT;

SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'oa_agreements' AND column_name = 'previous_company_name';
