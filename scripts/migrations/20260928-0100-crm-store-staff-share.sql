-- CRM Store — "Shared with staff" inside My files (Antonio 2026-09-28): a fixed folder in the owners' My files;
-- for EACH file in it the owners tick which staff logins may open / download it. Sandbox first (R105). Idempotent.

BEGIN;

-- the folder kind (files allowed; everything under it counts as shared-with-staff territory)
INSERT INTO public.catalog_entries (catalog_id, slug, display_name, status, metadata)
VALUES ('storage_folder_kinds', 'staff_share', 'Shared with staff', 'active', '{"accepts_files":true,"sort_order":5,"staff_share":true}')
ON CONFLICT (catalog_id, slug) DO NOTHING;

-- My files now comes with that one fixed folder (added to existing areas the next time they are opened —
-- store_apply_template only adds what is missing)
UPDATE public.catalog_entries
   SET metadata = jsonb_set(metadata, '{folders}', '[{"kind":"staff_share","name":"Shared with staff"}]'::jsonb)
 WHERE catalog_id = 'storage_folder_templates' AND slug = 'private_standard'
   AND NOT (metadata->'folders' @> '[{"kind":"staff_share"}]'::jsonb);

-- who may open each shared file (one row per file per staff login); service role only, like every store_* table
CREATE TABLE IF NOT EXISTS public.store_file_shares (
  file_id   uuid NOT NULL REFERENCES public.store_files(id) ON DELETE RESTRICT,
  user_id   uuid NOT NULL,
  shared_by uuid,
  shared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, user_id)
);
CREATE INDEX IF NOT EXISTS store_file_shares_user_idx ON public.store_file_shares (user_id);
ALTER TABLE public.store_file_shares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_file_shares FROM PUBLIC, anon, authenticated;

COMMIT;
