-- The app-level duplicate-name check (SELECT count, then INSERT/UPDATE)
-- has a real gap: two near-simultaneous requests — two staff members, or
-- one person double-clicking — can both pass the check before either
-- commits, producing the exact duplicate the check exists to prevent.
-- This backs it with an actual database guarantee. Two partial indexes
-- per table because NULL parent_id/folder_id (root-level items) never
-- collides against another NULL in a plain unique index.

CREATE UNIQUE INDEX crm_storage_folders_name_uq_nested
  ON public.crm_storage_folders (parent_id, lower(name))
  WHERE deleted_at IS NULL AND parent_id IS NOT NULL;

CREATE UNIQUE INDEX crm_storage_folders_name_uq_root
  ON public.crm_storage_folders (lower(name))
  WHERE deleted_at IS NULL AND parent_id IS NULL;

CREATE UNIQUE INDEX crm_storage_files_name_uq_nested
  ON public.crm_storage_files (folder_id, lower(file_name))
  WHERE deleted_at IS NULL AND folder_id IS NOT NULL;

CREATE UNIQUE INDEX crm_storage_files_name_uq_root
  ON public.crm_storage_files (lower(file_name))
  WHERE deleted_at IS NULL AND folder_id IS NULL;
