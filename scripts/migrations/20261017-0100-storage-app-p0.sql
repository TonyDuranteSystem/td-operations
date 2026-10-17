-- Storage Mac app, phase P0 (dev job 1992a087): device sign-in tables + the change feed.
-- SANDBOX first (R105). UNDO: 20261017-0100-storage-app-p0.UNDO.sql
--
-- 1) storage_app_devices / storage_app_auth_codes / storage_app_tokens — the Mac app's own sign-in
--    (OAuth code + PKCE). Only HASHES of codes and tokens are stored. RLS on, no policies: only the
--    service role (behind routes that check the user) can reach them, like every store_* table.
-- 2) store_change_log + triggers on the store tables themselves (and on the CRM rows that decide an
--    owner's name / group): ONE place that sees EVERY write — the CRM, imports, the Drive pickup
--    job, purges — so Finder can never miss a change because a code path forgot to report it.
--    The cursor is (txid, seq), not seq alone: a row that commits late can never fall behind it.

-- ───────────────────────────────────────────── sign-in
CREATE TABLE IF NOT EXISTS public.storage_app_devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  last_ip_trunc text,
  revoked_at    timestamptz,
  revoked_reason text
);
CREATE INDEX IF NOT EXISTS storage_app_devices_user_idx ON public.storage_app_devices (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.storage_app_auth_codes (
  code_hash      text PRIMARY KEY,
  user_id        uuid NOT NULL,
  device_name    text NOT NULL,
  code_challenge text NOT NULL,
  redirect_uri   text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz
);

CREATE TABLE IF NOT EXISTS public.storage_app_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   uuid NOT NULL REFERENCES public.storage_app_devices(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('access','refresh')),
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz              -- refresh tokens only: set once, atomically, when rotated
);
CREATE INDEX IF NOT EXISTS storage_app_tokens_device_idx ON public.storage_app_tokens (device_id, kind, created_at DESC);

ALTER TABLE public.storage_app_devices   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storage_app_auth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storage_app_tokens    ENABLE ROW LEVEL SECURITY;

-- ───────────────────────────────────────────── change feed
CREATE TABLE IF NOT EXISTS public.store_change_log (
  seq           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  txid          xid8 NOT NULL DEFAULT pg_current_xact_id(),
  at            timestamptz NOT NULL DEFAULT now(),
  item_kind     text NOT NULL CHECK (item_kind IN ('file','folder','owner')),
  item_id       uuid NOT NULL,
  op            text NOT NULL CHECK (op IN ('upsert','delete')),
  owner_id      uuid,
  parent_id     uuid,
  old_owner_id  uuid,
  old_parent_id uuid,
  name          text
);
CREATE INDEX IF NOT EXISTS store_change_log_cursor_idx ON public.store_change_log (txid, seq);
CREATE INDEX IF NOT EXISTS store_change_log_at_idx ON public.store_change_log (at);
ALTER TABLE public.store_change_log ENABLE ROW LEVEL SECURITY;

-- how far the log has been pruned: a device whose cursor is older than this must do a full refresh
CREATE TABLE IF NOT EXISTS public.store_change_floor (
  id         int PRIMARY KEY CHECK (id = 1),
  floor_txid xid8 NOT NULL
);
ALTER TABLE public.store_change_floor ENABLE ROW LEVEL SECURITY;
INSERT INTO public.store_change_floor (id, floor_txid) VALUES (1, '0'::xid8) ON CONFLICT (id) DO NOTHING;

-- files: what Finder shows is "live and not trashed/purged". Becoming visible = upsert, leaving = delete.
CREATE OR REPLACE FUNCTION public.store_change_log_file() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE vis_old boolean := false; vis_new boolean := false;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    vis_old := OLD.state = 'live' AND OLD.trashed_at IS NULL AND OLD.purged_at IS NULL;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    vis_new := NEW.state = 'live' AND NEW.trashed_at IS NULL AND NEW.purged_at IS NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF vis_old THEN
      INSERT INTO store_change_log (item_kind, item_id, op, owner_id, parent_id, name) VALUES ('file', OLD.id, 'delete', OLD.owner_id, OLD.folder_id, OLD.name);
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF vis_new THEN
      INSERT INTO store_change_log (item_kind, item_id, op, owner_id, parent_id, name) VALUES ('file', NEW.id, 'upsert', NEW.owner_id, NEW.folder_id, NEW.name);
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: only when something Finder shows changed
  IF vis_old AND NOT vis_new THEN
    INSERT INTO store_change_log (item_kind, item_id, op, owner_id, parent_id, name) VALUES ('file', OLD.id, 'delete', OLD.owner_id, OLD.folder_id, OLD.name);
  ELSIF vis_new AND (NOT vis_old OR OLD.name IS DISTINCT FROM NEW.name OR OLD.folder_id IS DISTINCT FROM NEW.folder_id
        OR OLD.owner_id IS DISTINCT FROM NEW.owner_id OR OLD.current_version_id IS DISTINCT FROM NEW.current_version_id
        OR OLD.document_type IS DISTINCT FROM NEW.document_type) THEN
    INSERT INTO store_change_log (item_kind, item_id, op, owner_id, parent_id, old_owner_id, old_parent_id, name)
    VALUES ('file', NEW.id, 'upsert', NEW.owner_id, NEW.folder_id,
            CASE WHEN vis_old AND OLD.owner_id IS DISTINCT FROM NEW.owner_id THEN OLD.owner_id END,
            CASE WHEN vis_old AND OLD.folder_id IS DISTINCT FROM NEW.folder_id THEN OLD.folder_id END, NEW.name);
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.store_change_log_folder() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE vis_old boolean := false; vis_new boolean := false;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN vis_old := OLD.trashed_at IS NULL; END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN vis_new := NEW.trashed_at IS NULL; END IF;
  IF TG_OP = 'DELETE' THEN
    IF vis_old THEN
      INSERT INTO store_change_log (item_kind, item_id, op, owner_id, parent_id, name) VALUES ('folder', OLD.id, 'delete', OLD.owner_id, OLD.parent_id, OLD.name);
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF vis_new THEN
      INSERT INTO store_change_log (item_kind, item_id, op, owner_id, parent_id, name) VALUES ('folder', NEW.id, 'upsert', NEW.owner_id, NEW.parent_id, NEW.name);
    END IF;
    RETURN NEW;
  END IF;
  IF vis_old AND NOT vis_new THEN
    INSERT INTO store_change_log (item_kind, item_id, op, owner_id, parent_id, name) VALUES ('folder', OLD.id, 'delete', OLD.owner_id, OLD.parent_id, OLD.name);
  ELSIF vis_new AND (NOT vis_old OR OLD.name IS DISTINCT FROM NEW.name OR OLD.parent_id IS DISTINCT FROM NEW.parent_id OR OLD.owner_id IS DISTINCT FROM NEW.owner_id) THEN
    INSERT INTO store_change_log (item_kind, item_id, op, owner_id, parent_id, old_owner_id, old_parent_id, name)
    VALUES ('folder', NEW.id, 'upsert', NEW.owner_id, NEW.parent_id,
            CASE WHEN vis_old AND OLD.owner_id IS DISTINCT FROM NEW.owner_id THEN OLD.owner_id END,
            CASE WHEN vis_old AND OLD.parent_id IS DISTINCT FROM NEW.parent_id THEN OLD.parent_id END, NEW.name);
  END IF;
  RETURN NEW;
END $$;

-- owners: an owner appears when it is live (study_only = false) and disappears when it is hidden again.
CREATE OR REPLACE FUNCTION public.store_change_log_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.study_only = false THEN
      INSERT INTO store_change_log (item_kind, item_id, op, owner_id) VALUES ('owner', OLD.id, 'delete', OLD.id);
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.study_only = false THEN
      INSERT INTO store_change_log (item_kind, item_id, op, owner_id) VALUES ('owner', NEW.id, 'upsert', NEW.id);
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.study_only = false AND NEW.study_only <> false THEN
    INSERT INTO store_change_log (item_kind, item_id, op, owner_id) VALUES ('owner', NEW.id, 'delete', NEW.id);
  ELSIF NEW.study_only = false AND (OLD.study_only <> false OR OLD.lifecycle_override IS DISTINCT FROM NEW.lifecycle_override
        OR OLD.account_id IS DISTINCT FROM NEW.account_id OR OLD.contact_id IS DISTINCT FROM NEW.contact_id
        OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.private_user_id IS DISTINCT FROM NEW.private_user_id) THEN
    INSERT INTO store_change_log (item_kind, item_id, op, owner_id) VALUES ('owner', NEW.id, 'upsert', NEW.id);
  END IF;
  RETURN NEW;
END $$;

-- the CRM rows that decide an owner's name and its group (company name, state, status, type; a person's name):
-- a closed client moving to another group is a MOVE for Finder, not a delete plus an add.
CREATE OR REPLACE FUNCTION public.store_change_log_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.company_name IS DISTINCT FROM NEW.company_name OR OLD.state_of_formation IS DISTINCT FROM NEW.state_of_formation
     OR OLD.status IS DISTINCT FROM NEW.status OR OLD.account_type IS DISTINCT FROM NEW.account_type THEN
    INSERT INTO store_change_log (item_kind, item_id, op, owner_id)
    SELECT 'owner', o.id, 'upsert', o.id FROM store_owners o WHERE o.account_id = NEW.id AND o.study_only = false;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.store_change_log_contact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.full_name IS DISTINCT FROM NEW.full_name OR OLD.first_name IS DISTINCT FROM NEW.first_name OR OLD.last_name IS DISTINCT FROM NEW.last_name THEN
    INSERT INTO store_change_log (item_kind, item_id, op, owner_id)
    SELECT 'owner', o.id, 'upsert', o.id FROM store_owners o WHERE o.contact_id = NEW.id AND o.study_only = false;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_store_change_log_file ON public.store_files;
CREATE TRIGGER trg_store_change_log_file AFTER INSERT OR UPDATE OR DELETE ON public.store_files
  FOR EACH ROW EXECUTE FUNCTION public.store_change_log_file();
DROP TRIGGER IF EXISTS trg_store_change_log_folder ON public.store_folders;
CREATE TRIGGER trg_store_change_log_folder AFTER INSERT OR UPDATE OR DELETE ON public.store_folders
  FOR EACH ROW EXECUTE FUNCTION public.store_change_log_folder();
DROP TRIGGER IF EXISTS trg_store_change_log_owner ON public.store_owners;
CREATE TRIGGER trg_store_change_log_owner AFTER INSERT OR UPDATE OR DELETE ON public.store_owners
  FOR EACH ROW EXECUTE FUNCTION public.store_change_log_owner();
DROP TRIGGER IF EXISTS trg_store_change_log_account ON public.accounts;
CREATE TRIGGER trg_store_change_log_account AFTER UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.store_change_log_account();
DROP TRIGGER IF EXISTS trg_store_change_log_contact ON public.contacts;
CREATE TRIGGER trg_store_change_log_contact AFTER UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.store_change_log_contact();

-- Read the feed from a cursor. Returns ONLY rows whose transaction is older than every transaction still in
-- flight, ordered by (txid, seq): a late-committing row always has a txid at or above the snapshot's xmin, so it
-- can never land behind a cursor that was already handed out.
CREATE OR REPLACE FUNCTION public.store_changes_since(p_after_txid xid8, p_after_seq bigint, p_limit int DEFAULT 500)
RETURNS TABLE (seq bigint, txid text, item_kind text, item_id uuid, op text, owner_id uuid, parent_id uuid,
               old_owner_id uuid, old_parent_id uuid, name text, resync boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE floor_x xid8; need_resync boolean;
BEGIN
  SELECT floor_txid INTO floor_x FROM store_change_floor WHERE id = 1;
  -- <= : a cursor sitting exactly ON the pruned tip cannot prove it saw the rest of that transaction
  need_resync := p_after_txid IS NOT NULL AND floor_x > '0'::xid8 AND p_after_txid <= floor_x;
  IF need_resync THEN
    RETURN QUERY SELECT 0::bigint, '0'::text, ''::text, NULL::uuid, ''::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, true;
    RETURN;
  END IF;
  RETURN QUERY
    SELECT c.seq, c.txid::text, c.item_kind, c.item_id, c.op, c.owner_id, c.parent_id, c.old_owner_id, c.old_parent_id, c.name, false
    FROM store_change_log c
    WHERE (p_after_txid IS NULL OR (c.txid, c.seq) > (p_after_txid, p_after_seq))
      AND c.txid < pg_snapshot_xmin(pg_current_snapshot())
    ORDER BY c.txid, c.seq
    LIMIT GREATEST(1, LEAST(p_limit, 2000));
END $$;

-- The newest cursor that is safe to start from (a device that has just done a full listing begins here).
CREATE OR REPLACE FUNCTION public.store_changes_head()
RETURNS TABLE (txid text, seq bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.txid::text, c.seq FROM store_change_log c
  WHERE c.txid < pg_snapshot_xmin(pg_current_snapshot())
  ORDER BY c.txid DESC, c.seq DESC LIMIT 1
$$;

-- Keep 30 days of log; the floor records how far we pruned so an old cursor is told to refresh in full.
CREATE OR REPLACE FUNCTION public.store_change_log_prune(p_keep interval DEFAULT interval '30 days') RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cut xid8; n bigint;
BEGIN
  SELECT max(c.txid) INTO cut FROM store_change_log c WHERE c.at < now() - p_keep AND c.txid < pg_snapshot_xmin(pg_current_snapshot());
  IF cut IS NULL THEN RETURN 0; END IF;
  DELETE FROM store_change_log c WHERE c.txid <= cut;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE store_change_floor SET floor_txid = GREATEST(floor_txid, cut) WHERE id = 1;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.store_changes_since(xid8, bigint, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_changes_head() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_change_log_prune(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_changes_since(xid8, bigint, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.store_changes_head() TO service_role;
GRANT EXECUTE ON FUNCTION public.store_change_log_prune(interval) TO service_role;

-- housekeeping for the sign-in tables (no cron calls it yet): used/expired codes after a day, expired access tokens after a day,
-- refresh tokens past the 30-day device cap, and devices revoked more than 90 days ago (their tokens go with them).
CREATE OR REPLACE FUNCTION public.storage_app_prune() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n bigint := 0; k bigint;
BEGIN
  DELETE FROM storage_app_auth_codes WHERE expires_at < now() - interval '1 day';                GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  DELETE FROM storage_app_tokens WHERE kind = 'access' AND expires_at < now() - interval '1 day'; GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  DELETE FROM storage_app_tokens WHERE kind = 'refresh' AND expires_at < now();                   GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  DELETE FROM storage_app_devices WHERE revoked_at IS NOT NULL AND revoked_at < now() - interval '90 days'; GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.storage_app_prune() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storage_app_prune() TO service_role;

-- the trigger functions are only ever called by their triggers
REVOKE ALL ON FUNCTION public.store_change_log_file() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_change_log_folder() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_change_log_owner() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_change_log_account() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_change_log_contact() FROM PUBLIC, anon, authenticated;
