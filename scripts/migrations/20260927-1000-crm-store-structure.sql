-- CRM Store — the storage STRUCTURE step (master plan v4.8.2 #94, Part 14): two new kinds of storage area.
--   business : the firm's own folders ("Business" on the left side) — ONE area, folders created by staff.
--   private  : a person-of-staff's own private area ("My files") — owned by ONE login (private_user_id);
--              only that login may open it (enforced by the app's routes; the store tables stay
--              service-role only, as every store_* table).
-- Sandbox first (R105). Idempotent.

BEGIN;

ALTER TABLE public.store_owners ADD COLUMN IF NOT EXISTS private_user_id uuid;

ALTER TABLE public.store_owners DROP CONSTRAINT IF EXISTS store_owners_kind_check;
ALTER TABLE public.store_owners ADD CONSTRAINT store_owners_kind_check
  CHECK (kind IN ('company','person','formation','unfiled','business','private'));

ALTER TABLE public.store_owners DROP CONSTRAINT IF EXISTS store_owners_shape;
ALTER TABLE public.store_owners ADD CONSTRAINT store_owners_shape CHECK (
     (kind = 'company'   AND account_id IS NOT NULL AND contact_id IS NULL AND private_user_id IS NULL)
  OR (kind = 'person'    AND contact_id IS NOT NULL AND account_id IS NULL AND service_delivery_id IS NULL AND private_user_id IS NULL)
  OR (kind = 'formation' AND service_delivery_id IS NOT NULL AND account_id IS NULL AND contact_id IS NULL AND private_user_id IS NULL)
  OR (kind IN ('unfiled','business') AND account_id IS NULL AND contact_id IS NULL AND service_delivery_id IS NULL AND private_user_id IS NULL)
  OR (kind = 'private'   AND private_user_id IS NOT NULL AND account_id IS NULL AND contact_id IS NULL AND service_delivery_id IS NULL)
);

ALTER TABLE public.store_owners DROP CONSTRAINT IF EXISTS store_owners_overlay_shape;
ALTER TABLE public.store_owners ADD CONSTRAINT store_owners_overlay_shape CHECK (
     (kind = 'formation' AND lifecycle_override IN ('in_formation','archived'))
  OR (kind = 'company'   AND (lifecycle_override IS NULL OR lifecycle_override = 'in_onboarding'))
  OR (kind IN ('person','unfiled','business','private') AND lifecycle_override IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS store_owners_business_uq ON public.store_owners ((CASE WHEN kind = 'business' THEN 1 END));
CREATE UNIQUE INDEX IF NOT EXISTS store_owners_private_uq  ON public.store_owners (private_user_id);

-- store_ensure_owner: + business (single area, no reference) and private (reference = the login's user id)
CREATE OR REPLACE FUNCTION public.store_ensure_owner(p_kind text, p_ref uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
  v_sd_account uuid;
  v_formation uuid;
BEGIN
  IF p_ref IS NULL AND p_kind NOT IN ('unfiled','business') THEN RAISE EXCEPTION 'store: owner reference required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('store_ensure:' || p_kind || ':' || coalesce(p_ref::text, ''), 0));

  IF p_kind = 'company' THEN
    SELECT id INTO v_id FROM public.store_owners WHERE account_id = p_ref;
    IF v_id IS NULL THEN
      SELECT o.service_delivery_id INTO v_formation
        FROM public.store_owners o JOIN public.service_deliveries sd ON sd.id = o.service_delivery_id
       WHERE o.kind = 'formation' AND o.lifecycle_override = 'in_formation' AND sd.account_id = p_ref
       ORDER BY o.created_at LIMIT 1;
      IF v_formation IS NOT NULL THEN
        RETURN public.store_attach_formation(v_formation, p_ref, NULL, NULL);
      END IF;
      INSERT INTO public.store_owners (kind, account_id) VALUES ('company', p_ref) RETURNING id INTO v_id;
    END IF;
  ELSIF p_kind = 'person' THEN
    SELECT id INTO v_id FROM public.store_owners WHERE contact_id = p_ref;
    IF v_id IS NULL THEN
      INSERT INTO public.store_owners (kind, contact_id) VALUES ('person', p_ref) RETURNING id INTO v_id;
    END IF;
  ELSIF p_kind = 'formation' THEN
    SELECT id INTO v_id FROM public.store_owners WHERE service_delivery_id = p_ref;
    IF v_id IS NULL THEN
      SELECT account_id INTO v_sd_account FROM public.service_deliveries WHERE id = p_ref;
      IF v_sd_account IS NOT NULL THEN
        RETURN public.store_ensure_owner('company', v_sd_account);
      END IF;
      INSERT INTO public.store_owners (kind, service_delivery_id, lifecycle_override)
      VALUES ('formation', p_ref, 'in_formation') RETURNING id INTO v_id;
    END IF;
  ELSIF p_kind IN ('unfiled','business') THEN
    SELECT id INTO v_id FROM public.store_owners WHERE kind = p_kind;
    IF v_id IS NULL THEN
      INSERT INTO public.store_owners (kind) VALUES (p_kind) RETURNING id INTO v_id;
    END IF;
  ELSIF p_kind = 'private' THEN
    SELECT id INTO v_id FROM public.store_owners WHERE private_user_id = p_ref;
    IF v_id IS NULL THEN
      INSERT INTO public.store_owners (kind, private_user_id) VALUES ('private', p_ref) RETURNING id INTO v_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'store: unknown owner kind %', p_kind;
  END IF;
  RETURN v_id;
END $$;

-- folder kinds for the two new top folders (files allowed at the top of both) + their templates (no fixed sub-folders)
INSERT INTO public.catalog_entries (catalog_id, slug, display_name, status, metadata)
VALUES
  ('storage_folder_kinds', 'business_root', 'Business', 'active', '{"accepts_files":true,"sort_order":0}'),
  ('storage_folder_kinds', 'private_root',  'My files', 'active', '{"accepts_files":true,"sort_order":0,"private":true}'),
  ('storage_folder_templates', 'business_standard', 'Business folders', 'active', '{"owner_kinds":["business"],"root_kind":"business_root","folders":[]}'),
  ('storage_folder_templates', 'private_standard',  'My files',         'active', '{"owner_kinds":["private"],"root_kind":"private_root","folders":[]}')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- the left side in ONE read (no 1,000-row page limit, no long id lists): every owner with its CRM name,
-- state and status, its top folder's name and its live-file count. Private areas only for their own login.
CREATE OR REPLACE FUNCTION public.store_navigation(p_user uuid)
RETURNS TABLE (id uuid, kind text, lifecycle_override text, company_name text, state_of_formation text,
               account_status text, person_name text, root_name text, file_count bigint)
LANGUAGE sql STABLE AS $$
  SELECT o.id, o.kind, o.lifecycle_override, a.company_name, a.state_of_formation, a.status::text, c.full_name,
         (SELECT f.name FROM public.store_folders f WHERE f.owner_id = o.id AND f.parent_id IS NULL LIMIT 1),
         (SELECT count(*) FROM public.store_files sf WHERE sf.owner_id = o.id AND sf.state = 'live')
    FROM public.store_owners o
    LEFT JOIN public.accounts a ON a.id = o.account_id
    LEFT JOIN public.contacts c ON c.id = o.contact_id
   WHERE o.kind <> 'private' OR (p_user IS NOT NULL AND o.private_user_id = p_user)
$$;
REVOKE ALL ON FUNCTION public.store_navigation(uuid) FROM PUBLIC, anon, authenticated;

-- "Decide later" (Part 16 rule 4): a file saved hidden and marked red "Needs review" until staff settle it.
ALTER TABLE public.store_files ADD COLUMN IF NOT EXISTS needs_review_at timestamptz;
ALTER TABLE public.store_files ADD COLUMN IF NOT EXISTS needs_review_reason text;
CREATE INDEX IF NOT EXISTS store_files_needs_review_idx ON public.store_files (owner_id) WHERE needs_review_at IS NOT NULL AND state = 'live';

-- The questions the system asks (Part 16): which exist, whether they are asked, their title and the words on
-- each choice are catalog DATA (a question switched off = the system does its default without asking).
-- metadata: { enabled, choices: { <choice key>: <label> } } — the choice keys are what the screens implement.
INSERT INTO public.catalog_definitions (id, display_name, description, admin_can_add_rows)
SELECT 'storage_questions', 'Storage — questions the system asks', 'Part 16 human step. metadata: enabled(bool), choices{key: label}. A question switched off = the default action without asking.', true
WHERE NOT EXISTS (SELECT 1 FROM public.catalog_definitions d WHERE d.id = 'storage_questions');

INSERT INTO public.catalog_entries (catalog_id, slug, display_name, status, metadata)
VALUES
  ('storage_questions', 'same_name_different_content', 'A file with this name is already here', 'active',
   '{"enabled":true,"choices":{"replace":"Replace it (the old copy is kept under Versions)","keep_both":"Keep both — save the new one as","cancel":"Cancel"}}'),
  ('storage_questions', 'identical_elsewhere', 'This exact file is already stored', 'active',
   '{"enabled":true,"choices":{"dont_add":"Don''t add it (keep the existing one)","rename_existing":"Rename the existing one to the new name","second_copy":"Add a second copy here","cancel":"Cancel"}}'),
  ('storage_questions', 'closed_company_upload', 'This company is closed or cancelled', 'active',
   '{"enabled":true,"choices":{"store_here":"Store it here (e.g. closure papers)","other_place":"Choose another client or folder…","business":"Business folders…","later":"Decide later"}}'),
  ('storage_questions', 'person_folder_from_company', 'This folder goes into the person''s own storage', 'active',
   '{"enabled":true,"choices":{"person":"Create it in the person''s storage (shows in each of their companies)","company":"Create it in this company''s own folders instead","cancel":"Cancel"}}'),
  ('storage_questions', 'tax_year_missing', 'Which tax year is this for?', 'active',
   '{"enabled":true,"choices":{"year":"Put it in","new_year":"New year folder","other_place":"Choose another folder…","cancel":"Cancel"}}'),
  ('storage_questions', 'prepared_tax_return', 'Is this the filed return or a draft?', 'active',
   '{"enabled":true,"choices":{"filed":"It''s the filed return (can be shown to the client)","draft":"It''s a draft for review (never shown until marked filed)","later":"Decide later"}}'),
  ('storage_questions', 'move_visible_file', 'The client can see this file', 'active',
   '{"enabled":true,"choices":{"keep":"Move it and keep it visible","hide":"Move it and hide it","cancel":"Cancel the move"}}'),
  ('storage_questions', 'folder_with_visible_files', 'The client can see files in this folder', 'active',
   '{"enabled":true,"choices":{"all":"Continue with everything","hide_first":"Hide the visible ones first, then continue","pick":"Pick which ones to hide","cancel":"Cancel"}}'),
  ('storage_questions', 'show_personal_data', 'This document holds personal data', 'active',
   '{"enabled":true,"choices":{"owner_only":"Show it to","keep_hidden":"Keep it hidden"}}')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- Every live file under a folder, all levels, in ONE read (no request-size or 1,000-row limits) — for the
-- folder move / delete questions, the delete itself and the category refresh. Trashed sub-folders are skipped.
CREATE OR REPLACE FUNCTION public.store_subtree_files(p_folder uuid)
RETURNS TABLE (id uuid, name text, folder_id uuid, visible boolean)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE t AS (
    SELECT f.id FROM public.store_folders f WHERE f.id = p_folder
    UNION ALL
    SELECT c.id FROM public.store_folders c JOIN t ON c.parent_id = t.id WHERE c.trashed_at IS NULL
  )
  SELECT sf.id, sf.name, sf.folder_id,
         EXISTS (SELECT 1 FROM public.documents d WHERE d.drive_file_id = 'store:' || sf.id::text AND d.portal_visible IS TRUE)
    FROM public.store_files sf JOIN t ON sf.folder_id = t.id
   WHERE sf.state = 'live'
$$;
REVOKE ALL ON FUNCTION public.store_subtree_files(uuid) FROM PUBLIC, anon, authenticated;

-- A folder's files' facts in ONE call (personal? staff-only type? how many versions?) instead of three
-- round-trips per file.
CREATE OR REPLACE FUNCTION public.store_files_facts(p_ids uuid[])
RETURNS TABLE (id uuid, is_personal boolean, staff_only boolean, version_count integer)
LANGUAGE sql STABLE AS $$
  SELECT f.id, public.store_file_is_personal(f.id), public.store_type_staff_only(f.document_type),
         (SELECT count(*)::int FROM public.store_file_versions v WHERE v.file_id = f.id)
    FROM public.store_files f WHERE f.id = ANY (p_ids)
$$;
REVOKE ALL ON FUNCTION public.store_files_facts(uuid[]) FROM PUBLIC, anon, authenticated;

-- The backup completeness alarm: the Business and "My files" areas are not backed up (not decided yet), so
-- their files are not "missing" and their names are never listed in the alarm (same bodies as slice 5, plus
-- the one exclusion).
CREATE OR REPLACE FUNCTION public.store_backup_gaps(p_late interval DEFAULT interval '6 hours', p_limit_per_kind integer DEFAULT 100)
RETURNS TABLE (kind text, owner_id uuid, file_id uuid, detail text) LANGUAGE sql STABLE AS $$
  (SELECT 'owner_failing', s.owner_id, NULL::uuid, s.last_error FROM public.store_backup_state s
    WHERE s.consecutive_failures >= 3 ORDER BY s.last_error_at DESC LIMIT p_limit_per_kind)
  UNION ALL
  (SELECT 'owner_late', s.owner_id, NULL::uuid, 'changes waiting since ' || min(e.occurred_at)::text
     FROM public.store_backup_state s JOIN public.store_events e ON e.owner_id = s.owner_id AND e.id > s.last_event_id
    WHERE NOT EXISTS (SELECT 1 FROM public.store_owners o WHERE o.id = s.owner_id AND o.kind IN ('business','private'))
    GROUP BY s.owner_id HAVING min(e.occurred_at) < now() - p_late LIMIT p_limit_per_kind)
  UNION ALL
  (SELECT 'no_bytes', f.owner_id, f.id, f.name FROM public.store_files f
    WHERE f.state = 'live' AND f.current_version_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.store_owners o WHERE o.id = f.owner_id AND o.kind IN ('business','private'))
    LIMIT p_limit_per_kind)
  UNION ALL
  (SELECT CASE f.state WHEN 'live' THEN 'missing_file' ELSE 'protected_missing' END, f.owner_id, f.id, f.name
     FROM public.store_files f
    WHERE f.state IN ('live','trashed') AND f.current_version_id IS NOT NULL AND NOT public.store_backup_file_ok(f.id)
      AND NOT EXISTS (SELECT 1 FROM public.store_owners o WHERE o.id = f.owner_id AND o.kind IN ('business','private'))
    LIMIT p_limit_per_kind)
$$;

CREATE OR REPLACE FUNCTION public.store_backup_gap_counts(p_late interval DEFAULT interval '6 hours')
RETURNS TABLE (kind text, n bigint) LANGUAGE sql STABLE AS $$
  SELECT 'missing_file', count(*) FROM public.store_files f
   WHERE f.state = 'live' AND f.current_version_id IS NOT NULL AND NOT public.store_backup_file_ok(f.id)
     AND NOT EXISTS (SELECT 1 FROM public.store_owners o WHERE o.id = f.owner_id AND o.kind IN ('business','private'))
  UNION ALL SELECT 'protected_missing', count(*) FROM public.store_files f
   WHERE f.state = 'trashed' AND NOT public.store_backup_file_ok(f.id)
     AND NOT EXISTS (SELECT 1 FROM public.store_owners o WHERE o.id = f.owner_id AND o.kind IN ('business','private'))
  UNION ALL SELECT 'no_bytes', count(*) FROM public.store_files f WHERE f.state = 'live' AND f.current_version_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.store_owners o WHERE o.id = f.owner_id AND o.kind IN ('business','private'))
  UNION ALL SELECT 'owner_failing', count(*) FROM public.store_backup_state s WHERE s.consecutive_failures >= 3
  UNION ALL SELECT 'owner_late', count(*) FROM (
    SELECT s.owner_id FROM public.store_backup_state s JOIN public.store_events e ON e.owner_id = s.owner_id AND e.id > s.last_event_id
     WHERE NOT EXISTS (SELECT 1 FROM public.store_owners o WHERE o.id = s.owner_id AND o.kind IN ('business','private'))
     GROUP BY s.owner_id HAVING min(e.occurred_at) < now() - p_late) x
$$;

-- Which of a PERSON's folders a company page may show is catalog data and now fails CLOSED (a folder kind without
-- the setting is not shown): the person's top folder and staff-made folders are marked shown; personal was already.
UPDATE public.catalog_entries SET metadata = metadata || '{"shown_through_company":true}'::jsonb
 WHERE catalog_id = 'storage_folder_kinds' AND slug IN ('root','custom') AND (metadata->>'shown_through_company') IS DISTINCT FROM 'true';

COMMIT;
