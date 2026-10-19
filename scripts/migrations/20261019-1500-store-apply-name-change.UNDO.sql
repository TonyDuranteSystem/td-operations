-- UNDO of 20261019-1500-store-apply-name-change.sql (Change Name, Track S2).
-- Drops the five functions. REFUSES (raises, nothing changes) while any storage still has an APPLIED name change that has
-- not been undone: dropping store_undo_name_change would remove the only safe way back. Undo those first
-- (store_undo_name_change_for_account / store_undo_name_change). The 'name_change_*' history rows in store_events stay (append-only).
-- Run this BEFORE 20261019-1400-accounts-previous-name.UNDO.sql.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  v_n integer;
BEGIN
  IF to_regprocedure('public.store_apply_name_change(uuid,uuid,text,text,uuid,boolean)') IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM public.store_events e
     WHERE e.event = 'name_change_applied'
       AND NOT EXISTS (SELECT 1 FROM public.store_events u
                        WHERE u.owner_id = e.owner_id AND u.event = 'name_change_undone'
                          AND u.details->>'change_id' = e.details->>'change_id' AND u.id > e.id);
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'undo refused: % storage name change(s) are still applied — undo them first (store_undo_name_change_for_account)', v_n;
    END IF;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.store_undo_name_change_for_account(uuid, uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.store_apply_name_change_for_account(uuid, uuid, text, text, uuid, boolean);
DROP FUNCTION IF EXISTS public.store_undo_name_change(uuid, uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.store_apply_name_change(uuid, uuid, text, text, uuid, boolean);
DROP FUNCTION IF EXISTS public.store_safe_folder_name(text);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN
       ('store_safe_folder_name', 'store_apply_name_change', 'store_undo_name_change', 'store_apply_name_change_for_account', 'store_undo_name_change_for_account')) THEN
    RAISE EXCEPTION 'verify: a function is still there';
  END IF;
END $$;

COMMIT;

SELECT (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'store%name_change%') AS remaining_functions;
