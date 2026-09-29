-- CRM Store — the STUDY copy (Antonio 2026-09-29: "a button connected to Google Drive … I pick one client's folder,
-- it goes into our storage, we organise it and create the rules"). A run is either a real MOVE (the switch-over:
-- records re-pointed) or a COPY (files copied into the new storage, the client's records untouched — nothing
-- changes for the client). Sandbox first (R105). Idempotent.
BEGIN;
ALTER TABLE public.store_import_runs ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'move';
ALTER TABLE public.store_import_runs DROP CONSTRAINT IF EXISTS store_import_runs_mode_check;
ALTER TABLE public.store_import_runs ADD CONSTRAINT store_import_runs_mode_check CHECK (mode IN ('move','copy'));
-- a storage a study copy CREATED is "study only": the CRM keeps using Drive for that company / person (the company
-- page, the contact page, the Drive-folder refusal ignore it), the Drive backup never runs for it; a real move of
-- the company clears the mark
ALTER TABLE public.store_owners ADD COLUMN IF NOT EXISTS study_only boolean NOT NULL DEFAULT false;
COMMIT;
