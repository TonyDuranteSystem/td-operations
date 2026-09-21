-- CRM Storage v2 — desktop-first rebuild.
-- Replaces the earlier marker-file-based design (dropped in this session,
-- never pushed) with real folder rows, so an empty folder, a starred
-- folder, and a folder tree don't need a hidden placeholder file trick.

CREATE TABLE public.crm_storage_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES public.crm_storage_folders(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE public.crm_storage_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id uuid REFERENCES public.crm_storage_folders(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  storage_bucket text NOT NULL DEFAULT 'crm-files',
  storage_path text NOT NULL,
  mime_type text,
  file_size bigint,
  uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (storage_bucket, storage_path)
);

CREATE TABLE public.crm_storage_favorites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_id uuid REFERENCES public.crm_storage_folders(id) ON DELETE CASCADE,
  file_id uuid REFERENCES public.crm_storage_files(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_storage_favorites_one_target CHECK (
    (folder_id IS NOT NULL AND file_id IS NULL) OR (folder_id IS NULL AND file_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX crm_storage_favorites_user_folder_uq
  ON public.crm_storage_favorites(user_id, folder_id) WHERE folder_id IS NOT NULL;
CREATE UNIQUE INDEX crm_storage_favorites_user_file_uq
  ON public.crm_storage_favorites(user_id, file_id) WHERE file_id IS NOT NULL;

CREATE INDEX crm_storage_folders_parent_idx ON public.crm_storage_folders(parent_id) WHERE deleted_at IS NULL;
CREATE INDEX crm_storage_folders_name_trgm_idx ON public.crm_storage_folders USING gin (name gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX crm_storage_files_folder_idx ON public.crm_storage_files(folder_id) WHERE deleted_at IS NULL;
CREATE INDEX crm_storage_files_name_trgm_idx ON public.crm_storage_files USING gin (file_name gin_trgm_ops) WHERE deleted_at IS NULL;

ALTER TABLE public.crm_storage_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_storage_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_storage_favorites ENABLE ROW LEVEL SECURITY;

CREATE POLICY crm_storage_folders_staff_only ON public.crm_storage_folders
  FOR ALL TO authenticated
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');

CREATE POLICY crm_storage_files_staff_only ON public.crm_storage_files
  FOR ALL TO authenticated
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');

-- Favorites are per-user by design (a starred folder is a personal
-- shortcut, not a shared setting) — staff can only see/manage their own.
CREATE POLICY crm_storage_favorites_own_rows ON public.crm_storage_favorites
  FOR ALL TO authenticated
  USING (user_id = auth.uid() AND COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (user_id = auth.uid() AND COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');

REVOKE ALL ON public.crm_storage_folders FROM anon;
REVOKE ALL ON public.crm_storage_folders FROM PUBLIC;
REVOKE ALL ON public.crm_storage_files FROM anon;
REVOKE ALL ON public.crm_storage_files FROM PUBLIC;
REVOKE ALL ON public.crm_storage_favorites FROM anon;
REVOKE ALL ON public.crm_storage_favorites FROM PUBLIC;

INSERT INTO storage.buckets (id, name, public)
VALUES ('crm-files', 'crm-files', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY crm_files_bucket_staff_only ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'crm-files' AND COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (bucket_id = 'crm-files' AND COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');
