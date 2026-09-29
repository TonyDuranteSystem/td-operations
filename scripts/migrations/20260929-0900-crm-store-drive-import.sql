-- CRM Store — "Move this company to the new storage" (Stage 2 mechanics, sandbox first; Antonio "go" 2026-09-29).
-- A run walks the company's real Drive folder (and its CRM rows kept in Supabase Storage), copies every file
-- into the store, re-points the CRM documents rows IN PLACE (same row, same client visibility) and keeps a
-- per-file ledger: what each Drive file became, the row's old pointer (rollback) and the parity facts.
--   · store_import_runs   — one move of one company (status, who, the parity report)
--   · store_import_items  — one row per source file: Drive file (or storage: object) → store file, status,
--                           size / md5 / sha, the documents rows re-pointed with their OLD pointers
--   · store_import_record_ref — the backup's "already safe in Drive" row for an imported file ('import'
--                           direction, status ok + the version's sha: the backup then never re-copies it)
-- Service role only (RLS on, no grants), like every store table. Idempotent. Sandbox first (R105).
BEGIN;

CREATE TABLE IF NOT EXISTS public.store_import_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES public.accounts(id),
  owner_id        uuid REFERENCES public.store_owners(id),
  drive_folder_id text,
  status          text NOT NULL DEFAULT 'scanning'
                  CHECK (status IN ('scanning','moving','done','incomplete','failed','rolled_back')),
  started_by      uuid,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  report          jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- one open (not finished, not undone) move per company at a time
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_import_runs_open
  ON public.store_import_runs (account_id) WHERE status IN ('scanning','moving');

CREATE TABLE IF NOT EXISTS public.store_import_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES public.store_import_runs(id) ON DELETE CASCADE,
  source           text NOT NULL CHECK (source IN ('drive','storage')),
  source_id        text NOT NULL,              -- Drive file id, or the storage: pointer
  drive_path       text[] NOT NULL DEFAULT '{}', -- folder names under the company's Drive folder
  name             text NOT NULL,
  mime_type        text,
  size_bytes       bigint,
  source_md5       text,                       -- what Drive says (parity)
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','done','merged','skipped','failed')),
  reason           text,                       -- why skipped / failed / merged (plain words)
  store_file_id    uuid REFERENCES public.store_files(id),
  sha256           text,                       -- of the bytes actually saved
  landed_in        text,                       -- plain path in the store ("1. Company › Bank")
  repointed        jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{id, drive_file_id, drive_link}] OLD pointers (rollback)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_store_import_items_run_status ON public.store_import_items (run_id, status);

-- The backup's view of an imported file: its Drive original holds exactly these bytes (s5 store_backup_file_ok
-- accepts an 'import' row with status ok and the current version's sha). One per store file (a merged duplicate
-- keeps its own ledger row in store_import_items). Never overwrites a different Drive id.
CREATE OR REPLACE FUNCTION public.store_import_record_ref(p_file_id uuid, p_drive_file_id text, p_sha256 text, p_drive_path jsonb)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.store_external_refs (object_kind, object_id, provider, direction, external_id, status, backed_up_sha256, drive_path, last_checked_at)
  VALUES ('file', p_file_id, 'gdrive', 'import', p_drive_file_id, 'ok', p_sha256, coalesce(p_drive_path, '{}'::jsonb), now())
  ON CONFLICT (object_kind, object_id, provider, direction) DO UPDATE
     SET backed_up_sha256 = EXCLUDED.backed_up_sha256, status = 'ok', last_checked_at = now(), updated_at = now()
   WHERE store_external_refs.external_id = EXCLUDED.external_id
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

ALTER TABLE public.store_import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_import_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_import_runs FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.store_import_items FROM anon, authenticated, PUBLIC;
REVOKE ALL ON FUNCTION public.store_import_record_ref(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;

COMMIT;
