-- UNDO: back to the 20261025-1500 body (does not touch held_slug values already written)
BEGIN;

CREATE OR REPLACE FUNCTION public.store_rehome_reconcile(p_file_ids uuid[], p_from_owner uuid, p_to_owner uuid, p_actor uuid)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_file uuid;
  v_ev record;
  r jsonb;
  v_links jsonb;
  v_subjects jsonb;
  v_dropped int := 0;
  v_file_row record;
BEGIN
  FOREACH v_file IN ARRAY coalesce(p_file_ids, ARRAY[]::uuid[]) LOOP
    SELECT id, folder_id, name INTO v_file_row FROM public.store_files WHERE id = v_file;
    IF NOT FOUND THEN CONTINUE; END IF;

    -- (a) coming BACK to an owner the file once left: put back what was dropped then (only what belongs)
    SELECT details INTO v_ev FROM public.store_events
     WHERE file_id = v_file AND event = 'rehome_dropped' AND details->>'from_owner' = p_to_owner::text
     ORDER BY id DESC LIMIT 1;
    IF FOUND THEN
      FOR r IN SELECT * FROM jsonb_array_elements(coalesce(v_ev.details->'links', '[]'::jsonb)) LOOP
        IF public.store_link_belongs(p_to_owner, r->>'link_kind', (r->>'record_id')::uuid) THEN
          INSERT INTO public.store_record_links (file_id, link_kind, record_id, stage_at_creation, tax_year, created_at)
          VALUES (v_file, r->>'link_kind', (r->>'record_id')::uuid, r->>'stage_at_creation', (r->>'tax_year')::int,
                  coalesce((r->>'created_at')::timestamptz, now()))
          ON CONFLICT DO NOTHING;
        END IF;
      END LOOP;
      FOR r IN SELECT * FROM jsonb_array_elements(coalesce(v_ev.details->'subjects', '[]'::jsonb)) LOOP
        IF public.store_subject_belongs(p_to_owner, r->>'subject_kind', (r->>'contact_id')::uuid, (r->>'account_id')::uuid) THEN
          INSERT INTO public.store_file_subjects (file_id, subject_kind, contact_id, account_id, role, created_at)
          VALUES (v_file, r->>'subject_kind', (r->>'contact_id')::uuid, (r->>'account_id')::uuid, r->>'role',
                  coalesce((r->>'created_at')::timestamptz, now()))
          ON CONFLICT DO NOTHING;
        END IF;
      END LOOP;
    END IF;

    -- (b) drop what no longer belongs to the new owner (remember it in the history row)
    WITH gone AS (
      DELETE FROM public.store_record_links l
       WHERE l.file_id = v_file AND NOT public.store_link_belongs(p_to_owner, l.link_kind, l.record_id)
      RETURNING l.link_kind, l.record_id, l.stage_at_creation, l.tax_year, l.created_at)
    SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]'::jsonb) INTO v_links FROM gone;
    WITH gone AS (
      DELETE FROM public.store_file_subjects s
       WHERE s.file_id = v_file AND NOT public.store_subject_belongs(p_to_owner, s.subject_kind, s.contact_id, s.account_id)
      RETURNING s.subject_kind, s.contact_id, s.account_id, s.role, s.created_at)
    SELECT coalesce(jsonb_agg(to_jsonb(gone)), '[]'::jsonb) INTO v_subjects FROM gone;
    IF jsonb_array_length(v_links) + jsonb_array_length(v_subjects) > 0 THEN
      v_dropped := v_dropped + jsonb_array_length(v_links) + jsonb_array_length(v_subjects);
      INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot, reason, details)
      VALUES ('rehome_dropped', p_actor, p_to_owner, v_file, v_file_row.folder_id, v_file_row.name,
              'Links and people that do not belong to the new owner were removed',
              jsonb_build_object('from_owner', p_from_owner, 'to_owner', p_to_owner, 'links', v_links, 'subjects', v_subjects));
    END IF;
  END LOOP;
  RETURN v_dropped;
END $$;

COMMIT;
