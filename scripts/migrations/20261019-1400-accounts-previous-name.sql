-- Change Name, Track S3 (2026-10-19, dev job 26e97288, parent bb64c417): a company remembers its previous legal name.
--
--   accounts.previous_name  text     the name BEFORE the most recent name change (NULL = never changed)
--   accounts.name_history   jsonb    append-only list of name changes and their undos (see store_apply_name_change_for_account)
--
-- ADDITIVE and dark: no existing screen, flow or trigger reads these columns; nothing in the existing data changes
-- (every account gets previous_name NULL and an empty history). Written ONLY by store_apply_name_change_for_account /
-- store_undo_name_change_for_account (20261019-1500-store-apply-name-change.sql), never by a hand edit.
-- A view's `a.*` is expanded when the view is created, so adding columns changes no view; none of the existing accounts triggers touches company_name.
--
-- PRODUCTION: paste this whole block into the Supabase SQL editor (R105: sandbox first — applied there by
-- node scripts/apply-migration.js). Matching rollback: 20261019-1400-accounts-previous-name.UNDO.sql.
-- Run BEFORE 20261019-1500-store-apply-name-change.sql (the wrapper functions read these columns).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ─────────────────────────────────────────────────────────────── preflight (raises = nothing changes)
DO $$
BEGIN
  IF to_regclass('public.accounts') IS NULL THEN RAISE EXCEPTION 'preflight: table public.accounts not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'company_name') THEN
    RAISE EXCEPTION 'preflight: accounts.company_name not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'updated_at') THEN
    RAISE EXCEPTION 'preflight: accounts.updated_at not found';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────── columns
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS previous_name text;
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS name_history jsonb NOT NULL DEFAULT '[]'::jsonb;

-- No CHECK constraint on purpose: the guard trigger below keeps name_history an array without adding a constraint the code<->database
-- contract snapshot (db/constraints.prod.json) would have to track. (An earlier sandbox draft had one; this drops it if it is there.)
ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_name_history_is_array;

COMMENT ON COLUMN public.accounts.previous_name IS 'The company''s legal name BEFORE its most recent name change (NULL = never changed). Written only by store_apply_name_change_for_account / store_undo_name_change_for_account.';
COMMENT ON COLUMN public.accounts.name_history IS 'Append-only JSON array: one {type:"change"|"undo", change_id, at, by, old_name, new_name, previous_name_before, storage} entry per name change or undo. Existing entries can never be edited or removed.';

-- ─────────────────────────────────────────────────────────────── append-only guard
-- name_history is always a JSON array and may only grow: every existing entry must stay exactly where it is.
CREATE OR REPLACE FUNCTION public.accounts_name_history_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_old_len integer;
BEGIN
  IF NEW.name_history IS NULL OR jsonb_typeof(NEW.name_history) <> 'array' THEN
    RAISE EXCEPTION 'accounts: name_history must be a JSON array' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.name_history IS NOT DISTINCT FROM OLD.name_history THEN RETURN NEW; END IF;
  v_old_len := jsonb_array_length(OLD.name_history);
  IF jsonb_array_length(NEW.name_history) < v_old_len THEN
    RAISE EXCEPTION 'accounts: the name history is append-only — entries cannot be removed' USING ERRCODE = 'check_violation';
  END IF;
  IF v_old_len > 0 AND (
       SELECT coalesce(jsonb_agg(e ORDER BY i), '[]'::jsonb)
         FROM jsonb_array_elements(NEW.name_history) WITH ORDINALITY AS t(e, i)
        WHERE i <= v_old_len
     ) IS DISTINCT FROM OLD.name_history THEN
    RAISE EXCEPTION 'accounts: the name history is append-only — existing entries cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_accounts_name_history_guard ON public.accounts;
CREATE TRIGGER trg_accounts_name_history_guard
  BEFORE INSERT OR UPDATE OF name_history ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.accounts_name_history_guard();

REVOKE ALL ON FUNCTION public.accounts_name_history_guard() FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────── verification (raises = nothing changes)
DO $$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name IN ('previous_name', 'name_history')) <> 2 THEN
    RAISE EXCEPTION 'verify: the two new columns are not both there';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_accounts_name_history_guard' AND tgrelid = 'public.accounts'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'verify: the append-only guard trigger is missing';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- final check (one row)
SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name IN ('previous_name', 'name_history')) AS new_columns,
  (SELECT count(*) FROM public.accounts WHERE previous_name IS NOT NULL OR name_history <> '[]'::jsonb) AS accounts_with_a_name_history,
  (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_accounts_name_history_guard' AND NOT tgisinternal) AS guard_triggers;
