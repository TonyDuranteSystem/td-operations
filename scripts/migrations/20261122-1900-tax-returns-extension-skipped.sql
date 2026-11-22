-- "No extension needed": the choice staff make, with who and when, on the tax record of the year (Antonio, 22 Nov 2026, dev job 6f555c9f).
-- A standalone company tax return does not have to be extended — the extension is optional: staff either file it or mark it "no extension needed".
-- The choice is undoable (both columns go back to NULL) and the Exceptions list stops flagging a skipped extension.
-- Additive only: two nullable columns, nothing is rewritten, nothing is dropped. Safe to run before the code that reads them; the code also tolerates
-- the columns being absent (it then behaves as if nothing was ever skipped).
-- Apply to the SANDBOX first (node scripts/apply-migration.js <file>); Antonio applies it on production BEFORE the code that writes it is merged.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.tax_returns ADD COLUMN IF NOT EXISTS extension_skipped_at timestamptz;
ALTER TABLE public.tax_returns ADD COLUMN IF NOT EXISTS extension_skipped_by text;

COMMENT ON COLUMN public.tax_returns.extension_skipped_at IS 'When staff marked this return "no extension needed" (NULL = not skipped). Undone by setting both columns back to NULL.';
COMMENT ON COLUMN public.tax_returns.extension_skipped_by IS 'Who marked this return "no extension needed" (the staff member''s e-mail).';

DO $do$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tax_returns'
         AND column_name IN ('extension_skipped_at', 'extension_skipped_by')) <> 2 THEN
    RAISE EXCEPTION 'tax-returns-extension-skipped: the two columns are not both there after the change';
  END IF;
END
$do$;
COMMIT;

SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'tax_returns' AND column_name LIKE 'extension_skipped%' ORDER BY column_name;
