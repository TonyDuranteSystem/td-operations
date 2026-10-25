-- Storage: a legal hold STICKS to the file (dev job bd21e833 / storage-exposure bug hunt, 2026-10-25). Additive, idempotent; UNDO beside it.
-- The problem: store_file_purge_hold() decides a hold from things staff can change afterwards — the document type, the folder kind, the
-- filing status, the year, the service-case link ("Remove from view" = store_remove_link). A file that was under a hold (e.g. an ITIN
-- identity paper) could lose it by being re-typed / moved out of the ITIN folder / unlinked, and then be purged 90 days after a trash.
-- The fix (data layer, covers every writer): the hold a file is under is WRITTEN ON THE FILE the moment something that decides it is
-- about to change (type, folder, year, filing status), when it is trashed, and when its service-case link is removed.
--   store_files.held_slug        the hold (catalog 'storage_purge_holds' slug) the file fell under at that moment
--   store_files.held_basis_year  the year the hold's "years_after" counts from, frozen with it
-- store_file_purge_hold() now ALSO answers the frozen hold (until its years_after runs out; a null years_after = until a person clears it).
-- Clearing a frozen hold on purpose: UPDATE public.store_files SET held_slug = NULL, held_basis_year = NULL WHERE id = '…' (an owner decision).
-- The purge job is NOT scheduled by this migration.
BEGIN;

ALTER TABLE public.store_files ADD COLUMN IF NOT EXISTS held_slug text;
ALTER TABLE public.store_files ADD COLUMN IF NOT EXISTS held_basis_year integer;

-- the hold that keeps this file from being purged today (live attributes OR the frozen hold), or NULL
CREATE OR REPLACE FUNCTION public.store_file_purge_hold(p_file_id uuid, p_today date DEFAULT current_date)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT h.slug
    FROM public.store_files f
    JOIN public.store_folders d ON d.id = f.folder_id
    JOIN public.catalog_entries h ON h.catalog_id = 'storage_purge_holds' AND h.status = 'active'
   WHERE f.id = p_file_id
     AND ( f.held_slug = h.slug
        OR ( h.metadata->'document_types' ? coalesce(f.document_type, '')
         AND (h.metadata->'filing_statuses' IS NULL OR h.metadata->'filing_statuses' ? f.filing_status)
         AND ( (h.metadata->'folder_kinds' IS NULL AND h.metadata->'service_types' IS NULL)
            OR h.metadata->'folder_kinds' ? d.kind
            OR EXISTS (SELECT 1 FROM public.store_record_links l JOIN public.service_deliveries sd ON sd.id = l.record_id
                        WHERE l.file_id = f.id AND l.link_kind = 'service_case' AND h.metadata->'service_types' ? sd.service_type) ) ) )
     AND ( h.metadata->'years_after' IS NULL OR jsonb_typeof(h.metadata->'years_after') = 'null'
        OR make_date(coalesce(CASE WHEN f.held_slug = h.slug THEN f.held_basis_year END, f.period_year, extract(year FROM f.created_at)::int)
                     + (h.metadata->>'years_after')::int, 12, 31) >= p_today )
   ORDER BY h.slug LIMIT 1
$$;

-- write the hold on the file BEFORE anything that decides it changes (or the file goes to the trash)
CREATE OR REPLACE FUNCTION public.store_files_freeze_hold()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_hold text;
BEGIN
  IF OLD.held_slug IS NOT NULL OR OLD.state = 'purged' THEN RETURN NEW; END IF;
  IF NEW.document_type IS DISTINCT FROM OLD.document_type
     OR NEW.folder_id IS DISTINCT FROM OLD.folder_id
     OR NEW.period_year IS DISTINCT FROM OLD.period_year
     OR NEW.filing_status IS DISTINCT FROM OLD.filing_status
     OR (NEW.state = 'trashed' AND OLD.state <> 'trashed') THEN
    v_hold := public.store_file_purge_hold(OLD.id);          -- the table still holds the OLD values in a BEFORE trigger
    IF v_hold IS NOT NULL THEN
      NEW.held_slug := v_hold;
      NEW.held_basis_year := coalesce(OLD.period_year, extract(year FROM OLD.created_at)::int);
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_store_files_freeze_hold ON public.store_files;
CREATE TRIGGER trg_store_files_freeze_hold BEFORE UPDATE ON public.store_files
  FOR EACH ROW EXECUTE FUNCTION public.store_files_freeze_hold();
REVOKE ALL ON FUNCTION public.store_files_freeze_hold() FROM PUBLIC, anon, authenticated;

-- "Remove from view" (a service-case link is one of the things that decides a hold): freeze the hold first
CREATE OR REPLACE FUNCTION public.store_remove_link(p_file_id uuid, p_link_kind text, p_record_id uuid, p_actor uuid, p_reason text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  l record;
  f record;
  v_hold text;
  v_owner uuid;
BEGIN
  -- same lock ORDER as every other store function (owner lock first, then the rows): this keeps the deadlock fix of
  -- 20261025-1500-storage-datalayer-hardening.sql, which defined this function before this newer file did
  SELECT owner_id INTO v_owner FROM public.store_files WHERE id = p_file_id;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.store_lock_owner(v_owner);
  SELECT * INTO l FROM public.store_record_links WHERE file_id = p_file_id AND link_kind = p_link_kind AND record_id = p_record_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT owner_id, folder_id, name INTO f FROM public.store_files WHERE id = p_file_id;
  v_hold := public.store_file_purge_hold(p_file_id);
  IF v_hold IS NOT NULL THEN
    UPDATE public.store_files SET held_slug = v_hold, held_basis_year = coalesce(period_year, extract(year FROM created_at)::int)
     WHERE id = p_file_id AND held_slug IS NULL AND state <> 'purged';
  END IF;
  DELETE FROM public.store_record_links WHERE file_id = p_file_id AND link_kind = p_link_kind AND record_id = p_record_id;
  INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot, reason, details)
  VALUES ('link_removed', p_actor, f.owner_id, p_file_id, f.folder_id, f.name, p_reason, to_jsonb(l) - 'file_id');
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.store_remove_link(uuid, text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;

COMMIT;
