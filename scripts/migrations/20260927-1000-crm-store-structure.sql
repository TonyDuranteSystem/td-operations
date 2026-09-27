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

COMMIT;
