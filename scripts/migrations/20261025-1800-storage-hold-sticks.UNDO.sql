-- UNDO of 20261025-1800-storage-hold-sticks.sql. Frozen holds are LOST when the columns go — run the SELECT first and decide:
--   SELECT count(*) FROM public.store_files WHERE held_slug IS NOT NULL;
BEGIN;
DROP TRIGGER IF EXISTS trg_store_files_freeze_hold ON public.store_files;
DROP FUNCTION IF EXISTS public.store_files_freeze_hold();

-- store_file_purge_hold + store_remove_link back to the text of 20260925-2000-crm-store-s4-trash.sql
CREATE OR REPLACE FUNCTION public.store_file_purge_hold(p_file_id uuid, p_today date DEFAULT current_date)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT h.slug
    FROM public.store_files f
    JOIN public.store_folders d ON d.id = f.folder_id
    JOIN public.catalog_entries h ON h.catalog_id = 'storage_purge_holds' AND h.status = 'active'
   WHERE f.id = p_file_id
     AND h.metadata->'document_types' ? coalesce(f.document_type, '')
     AND (h.metadata->'filing_statuses' IS NULL OR h.metadata->'filing_statuses' ? f.filing_status)
     AND ( (h.metadata->'folder_kinds' IS NULL AND h.metadata->'service_types' IS NULL)
        OR h.metadata->'folder_kinds' ? d.kind
        OR EXISTS (SELECT 1 FROM public.store_record_links l JOIN public.service_deliveries sd ON sd.id = l.record_id
                    WHERE l.file_id = f.id AND l.link_kind = 'service_case' AND h.metadata->'service_types' ? sd.service_type) )
     AND ( h.metadata->'years_after' IS NULL OR jsonb_typeof(h.metadata->'years_after') = 'null'
        OR make_date(coalesce(f.period_year, extract(year FROM f.created_at)::int) + (h.metadata->>'years_after')::int, 12, 31) >= p_today )
   ORDER BY h.slug LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.store_remove_link(p_file_id uuid, p_link_kind text, p_record_id uuid, p_actor uuid, p_reason text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  l record;
  f record;
BEGIN
  SELECT * INTO l FROM public.store_record_links WHERE file_id = p_file_id AND link_kind = p_link_kind AND record_id = p_record_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT owner_id, folder_id, name INTO f FROM public.store_files WHERE id = p_file_id;
  DELETE FROM public.store_record_links WHERE file_id = p_file_id AND link_kind = p_link_kind AND record_id = p_record_id;
  INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot, reason, details)
  VALUES ('link_removed', p_actor, f.owner_id, p_file_id, f.folder_id, f.name, p_reason, to_jsonb(l) - 'file_id');
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.store_remove_link(uuid, text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;

ALTER TABLE public.store_files DROP COLUMN IF EXISTS held_slug;
ALTER TABLE public.store_files DROP COLUMN IF EXISTS held_basis_year;
COMMIT;
