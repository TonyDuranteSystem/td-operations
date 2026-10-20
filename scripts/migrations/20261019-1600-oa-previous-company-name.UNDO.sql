-- UNDO of 20261019-1600-oa-previous-company-name.sql — drops the column. REFUSES while any agreement carries a value (dropping it would
-- silently change the text of an agreement that may already be signed).
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.oa_agreements WHERE previous_company_name IS NOT NULL) THEN
    RAISE EXCEPTION 'oa-previous-company-name UNDO: % agreement(s) carry a previous name — nothing changed', (SELECT count(*) FROM public.oa_agreements WHERE previous_company_name IS NOT NULL);
  END IF;
END
$do$;
ALTER TABLE public.oa_agreements DROP COLUMN IF EXISTS previous_company_name;
COMMIT;
SELECT 'oa-previous-company-name undone' AS result;
