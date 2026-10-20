-- UNDO of 20261019-1400-accounts-previous-name.sql (Change Name, Track S3).
-- REFUSES (raises, nothing changes) if any account already carries a previous name or a name history:
-- dropping the columns would destroy the only record of that company's earlier names.
-- Run 20261019-1500-store-apply-name-change.UNDO.sql FIRST (its wrapper functions read these columns).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  v_n integer;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('store_apply_name_change_for_account', 'store_undo_name_change_for_account')) THEN
    RAISE EXCEPTION 'undo refused: the name-change wrapper functions still exist — run 20261019-1500-store-apply-name-change.UNDO.sql first';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'name_history') THEN
    EXECUTE 'SELECT count(*) FROM public.accounts WHERE previous_name IS NOT NULL OR name_history <> ''[]''::jsonb' INTO v_n;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'undo refused: % account(s) carry a previous name / name history — keep the columns (or export them first)', v_n;
    END IF;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_accounts_name_history_guard ON public.accounts;
DROP FUNCTION IF EXISTS public.accounts_name_history_guard();
ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_name_history_is_array;
ALTER TABLE public.accounts DROP COLUMN IF EXISTS name_history;
ALTER TABLE public.accounts DROP COLUMN IF EXISTS previous_name;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name IN ('previous_name', 'name_history')) THEN
    RAISE EXCEPTION 'verify: a column is still there';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;

SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name IN ('previous_name', 'name_history')) AS remaining_columns;
