-- UNDO for 20261007-0100-open-services-hidden-flag.sql.
-- Restores exactly what that migration wrote, using the before-state it logged in catalog_decision_log: for every key
-- the migration added or changed, the key is removed (if it was absent before) or put back to its old value. Keys
-- added by anyone else since are left alone. Run it only if the flag has to come off.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  l          record;
  k          text;
  v_before   jsonb;
  v_after    jsonb;
  v_current  jsonb;
  v_restored int := 0;
BEGIN
  PERFORM set_config('request.headers', '{"x-td-actor":"open-services-hidden-flag-2026-10-07-undo"}', true);

  FOR l IN
    SELECT catalog_entry_id, before_state, after_state
      FROM public.catalog_decision_log
     WHERE reason LIKE 'open-services hidden flag (N1a C3%'
       AND action = 'metadata_changed'
     ORDER BY created_at DESC
  LOOP
    v_before  := COALESCE(l.before_state->'metadata', '{}'::jsonb);
    v_after   := COALESCE(l.after_state->'metadata', '{}'::jsonb);
    SELECT COALESCE(metadata, '{}'::jsonb) INTO v_current FROM public.catalog_entries WHERE id = l.catalog_entry_id;
    CONTINUE WHEN v_current IS NULL;

    FOR k IN SELECT jsonb_object_keys(v_after) LOOP
      IF (v_after -> k) IS DISTINCT FROM (v_before -> k) THEN
        IF v_before ? k THEN
          v_current := v_current || jsonb_build_object(k, v_before -> k);
        ELSE
          v_current := v_current - k;
        END IF;
      END IF;
    END LOOP;

    UPDATE public.catalog_entries SET metadata = v_current, updated_at = now() WHERE id = l.catalog_entry_id;
    INSERT INTO public.catalog_decision_log (catalog_entry_id, catalog_id, action, actor_kind, reason, after_state)
    VALUES (l.catalog_entry_id, 'services', 'metadata_changed', 'migration',
            'UNDO open-services hidden flag (20261007-0100-open-services-hidden-flag.UNDO.sql)',
            jsonb_build_object('metadata', v_current));
    v_restored := v_restored + 1;
  END LOOP;

  RAISE NOTICE 'open-services flag undone on % card(s).', v_restored;
END $$;

COMMIT;
