-- N1a P2 — one recorded history of every change to a service card or its steps (dev job be7da01a, approved 2026-10-04).
--
-- Today most changes to service settings leave no trace: the service editor writes through the service_catalog view
-- (its trigger merges into catalog_entries without any log) and only step DELETES are logged. This records EVERY
-- change — editor, list page, invoice quick-create, /config, the MCP tools and raw SQL alike — in one table, written by
-- the database itself so no writer can skip it.
--
--   * Who: the app stamps each write with the request header x-td-actor (supabase-js .setHeader). A write without the
--     header (SQL editor, a migration, a missed caller) is recorded as "db:<role>". The actor is never read from a
--     column on the row, so a later change can't be credited to the last editor.
--   * Only real changes: an UPDATE that changes nothing but updated_at / updated_by is skipped; the service editor's
--     temporary "park" renumbering (stage_order >= 100000, lib/services/stages.ts PARK_FLOOR) is skipped.
--   * Recording can never block or half-break a real save: any error inside the recorder is turned into a WARNING.
--   * Staff-only: RLS on with no policies; anon / authenticated have no access. The app reads it with the service key.
--
-- Safe before or after the code deploy: old code simply writes without the header (recorded as "db:<role>").

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.service_settings_history (
  id             bigserial PRIMARY KEY,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  table_name     text        NOT NULL,          -- 'pipeline_stages' | 'catalog_entries'
  row_id         uuid,
  service_key    text,                          -- pipeline_stages.service_type | catalog_entries.slug
  op             text        NOT NULL CHECK (op IN ('INSERT', 'UPDATE', 'DELETE')),
  changed_fields text[],                        -- UPDATE only; metadata keys as 'metadata.<key>'
  before         jsonb,
  after          jsonb,
  actor          text        NOT NULL,
  txid           bigint      NOT NULL DEFAULT txid_current()
);
COMMENT ON TABLE public.service_settings_history IS
  'N1a P2: every change to a service card (catalog_entries, catalog_id=services) or a service step (pipeline_stages), recorded by trigger. actor = x-td-actor request header, else db:<role>.';

CREATE INDEX IF NOT EXISTS service_settings_history_key_idx
  ON public.service_settings_history (service_key, changed_at DESC);

ALTER TABLE public.service_settings_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.service_settings_history FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.service_settings_history_id_seq FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_service_settings_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old    jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  v_new    jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  v_row    jsonb := coalesce(v_new, v_old);
  -- A NULL metadata column arrives as JSON null (not SQL NULL) — treat anything that isn't an object as {}.
  v_om     jsonb := CASE WHEN jsonb_typeof(v_old -> 'metadata') = 'object' THEN v_old -> 'metadata' ELSE '{}'::jsonb END;
  v_nm     jsonb := CASE WHEN jsonb_typeof(v_new -> 'metadata') = 'object' THEN v_new -> 'metadata' ELSE '{}'::jsonb END;
  v_fields text[];
  v_actor  text;
  v_key    text;
BEGIN
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      SELECT array_agg(f ORDER BY f) INTO v_fields FROM (
        SELECT k AS f
          FROM jsonb_object_keys(v_new) AS k
         WHERE k NOT IN ('updated_at', 'updated_by', 'metadata')
           AND (v_new -> k) IS DISTINCT FROM (v_old -> k)
        UNION ALL
        SELECT 'metadata.' || mk
          FROM jsonb_object_keys(v_nm || v_om) AS mk
         WHERE (v_nm -> mk) IS DISTINCT FROM (v_om -> mk)
      ) s;

      IF v_fields IS NULL THEN
        RETURN NULL;  -- nothing but bookkeeping changed
      END IF;
      IF TG_TABLE_NAME = 'pipeline_stages' AND v_fields = ARRAY['stage_order']
         AND ((v_old ->> 'stage_order')::int >= 100000 OR (v_new ->> 'stage_order')::int >= 100000) THEN
        RETURN NULL;  -- the editor's temporary park renumbering
      END IF;
    END IF;

    v_actor := nullif(nullif(current_setting('request.headers', true), '')::json ->> 'x-td-actor', '');
    v_actor := coalesce(left(v_actor, 200), 'db:' || current_user);
    v_key := CASE WHEN TG_TABLE_NAME = 'pipeline_stages' THEN v_row ->> 'service_type' ELSE v_row ->> 'slug' END;

    INSERT INTO public.service_settings_history (table_name, row_id, service_key, op, changed_fields, before, after, actor)
    VALUES (TG_TABLE_NAME, (v_row ->> 'id')::uuid, v_key, TG_OP, v_fields, v_old, v_new, v_actor);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'service_settings_history: could not record % on % (%): %', TG_OP, TG_TABLE_NAME, v_row ->> 'id', SQLERRM;
  END;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.record_service_settings_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_service_settings_history_stages ON public.pipeline_stages;
CREATE TRIGGER trg_service_settings_history_stages
  AFTER INSERT OR UPDATE OR DELETE ON public.pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION public.record_service_settings_change();

-- catalog_entries holds many catalogs; record service cards only (and a row moved into / out of 'services').
DROP TRIGGER IF EXISTS trg_service_settings_history_cards_ins ON public.catalog_entries;
CREATE TRIGGER trg_service_settings_history_cards_ins
  AFTER INSERT ON public.catalog_entries
  FOR EACH ROW WHEN (NEW.catalog_id = 'services')
  EXECUTE FUNCTION public.record_service_settings_change();

DROP TRIGGER IF EXISTS trg_service_settings_history_cards_upd ON public.catalog_entries;
CREATE TRIGGER trg_service_settings_history_cards_upd
  AFTER UPDATE ON public.catalog_entries
  FOR EACH ROW WHEN (NEW.catalog_id = 'services' OR OLD.catalog_id = 'services')
  EXECUTE FUNCTION public.record_service_settings_change();

DROP TRIGGER IF EXISTS trg_service_settings_history_cards_del ON public.catalog_entries;
CREATE TRIGGER trg_service_settings_history_cards_del
  AFTER DELETE ON public.catalog_entries
  FOR EACH ROW WHEN (OLD.catalog_id = 'services')
  EXECUTE FUNCTION public.record_service_settings_change();

COMMIT;
