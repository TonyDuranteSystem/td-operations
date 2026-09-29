-- CRM Store — foundation slice S1: the record model (2026-09-24, Antonio "start step 1").
-- Master plan v4.4 Part 8.1–8.3 (memory/plan_drive_to_crm_storage_master_plan.md),
-- dev job 685467b5 (parent bbf7bca1). Revised after the S1 pre-apply council.
--
-- WHAT THIS IS: the permanent record model of the new CRM storage that replaces
-- Google Drive. ADDITIVE and dark: no existing screen, flow or client-visible
-- behaviour changes. Nothing here creates owners/folders/files for real clients
-- (writers arrive in slice 2; owners are created lazily when the first file lands).
--
-- DELIBERATE DEVIATION FROM THE PLAN (recorded in the plan): the v1 CRM Storage
-- tables (crm_storage_*) are NOT dropped here — the live Storage screen still
-- uses them. They are retired when that screen moves onto this model.
--
-- DESIGN RULES:
--  * Every folder/file has exactly ONE owner (store_owners): company, person,
--    formation (storage-only, keyed to the formation service case) or the single
--    Unfiled owner.
--  * Company active/archived is NOT stored: it is read from accounts.status through
--    the storage_lifecycle_map catalog. Only storage-only overlays are stored
--    (in_formation / in_onboarding / archived for a cancelled formation).
--  * No cascade deletes. Deletes of store rows, and edits of saved versions, are
--    refused except inside the privileged functions (the slice-4 purge).
--  * Cross-owner moves only through store_rehome_subtree()/store_rehome_file()/
--    store_attach_formation(), which set a transaction-local flag the guard
--    triggers check, under per-owner advisory locks.
--  * Business vocabularies are catalog data; structural states are CHECKs.
--  * Access: RLS on with NO policies → only the service role (server routes with
--    the explicit staff allow-list, lib/crm-store/access.ts) can read or write.
--  * Membership end for the members list reuses members.end_date from the
--    "member ownership periods" work (dev job f4c5c023, unshipped) — NOT added here.

BEGIN;

-- ─────────────────────────────────────────────────────────────── helpers
CREATE OR REPLACE FUNCTION public.store_name_key(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(normalize(btrim(p_name), NFC))
$$;

CREATE OR REPLACE FUNCTION public.store_role_key(p_role text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(regexp_replace(btrim(coalesce(p_role, '')), '[[:space:]_]+', ' ', 'g'))
$$;

CREATE OR REPLACE FUNCTION public.store_is_privileged()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('store.privileged', true), '') = 'on'
$$;

CREATE OR REPLACE FUNCTION public.store_lock_owner(p_owner_id uuid)
RETURNS void LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('store_owner:' || p_owner_id::text, 0))
$$;

-- ─────────────────────────────────────────────────────────────── soft end of company–person links
-- (portal audience + Contacts view read account_contacts; the code paths that today
--  hard-delete these links switch to a soft end in slice 3)
ALTER TABLE public.account_contacts ADD COLUMN IF NOT EXISTS ended_at     timestamptz;
ALTER TABLE public.account_contacts ADD COLUMN IF NOT EXISTS ended_by     uuid;
ALTER TABLE public.account_contacts ADD COLUMN IF NOT EXISTS access_until timestamptz;

-- ─────────────────────────────────────────────────────────────── owners
CREATE TABLE IF NOT EXISTS public.store_owners (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 text NOT NULL CHECK (kind IN ('company','person','formation','unfiled')),
  account_id           uuid REFERENCES public.accounts(id) ON DELETE RESTRICT,
  contact_id           uuid REFERENCES public.contacts(id) ON DELETE RESTRICT,
  service_delivery_id  uuid REFERENCES public.service_deliveries(id) ON DELETE RESTRICT,
  lifecycle_override   text CHECK (lifecycle_override IN ('in_formation','in_onboarding','archived')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_owners_shape CHECK (
       (kind = 'company'   AND account_id IS NOT NULL AND contact_id IS NULL)
    OR (kind = 'person'    AND contact_id IS NOT NULL AND account_id IS NULL AND service_delivery_id IS NULL)
    OR (kind = 'formation' AND service_delivery_id IS NOT NULL AND account_id IS NULL AND contact_id IS NULL)
    OR (kind = 'unfiled'   AND account_id IS NULL AND contact_id IS NULL AND service_delivery_id IS NULL)
  ),
  CONSTRAINT store_owners_overlay_shape CHECK (
       (kind = 'formation' AND lifecycle_override IN ('in_formation','archived'))
    OR (kind = 'company'   AND (lifecycle_override IS NULL OR lifecycle_override = 'in_onboarding'))
    OR (kind IN ('person','unfiled') AND lifecycle_override IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS store_owners_account_uq  ON public.store_owners (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS store_owners_contact_uq  ON public.store_owners (contact_id);
CREATE UNIQUE INDEX IF NOT EXISTS store_owners_sd_uq       ON public.store_owners (service_delivery_id);
CREATE UNIQUE INDEX IF NOT EXISTS store_owners_unfiled_uq  ON public.store_owners ((CASE WHEN kind = 'unfiled' THEN 1 END));

-- ─────────────────────────────────────────────────────────────── folders
CREATE TABLE IF NOT EXISTS public.store_folders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES public.store_owners(id) ON DELETE RESTRICT,
  parent_id       uuid REFERENCES public.store_folders(id) ON DELETE RESTRICT,
  kind            text NOT NULL,
  template_slug   text,
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 255 AND name !~ '[/\\[:cntrl:]]'),
  name_key        text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  trashed_at      timestamptz,
  trashed_by      uuid,
  trash_batch_id  uuid,
  CONSTRAINT store_folders_trash_shape CHECK ((trashed_at IS NULL) = (name_key IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS store_folders_sibling_name_uq
  ON public.store_folders (owner_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name_key);
CREATE UNIQUE INDEX IF NOT EXISTS store_folders_one_root_uq
  ON public.store_folders ((CASE WHEN parent_id IS NULL THEN owner_id END));
CREATE INDEX IF NOT EXISTS store_folders_parent_idx ON public.store_folders (parent_id);
CREATE INDEX IF NOT EXISTS store_folders_owner_idx  ON public.store_folders (owner_id);

CREATE OR REPLACE FUNCTION public.store_folders_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_parent record;
  v_hit uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT public.store_is_privileged() THEN
      RAISE EXCEPTION 'store: folders are never deleted (trash them instead)' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  NEW.updated_at := now();
  NEW.name_key := CASE WHEN NEW.trashed_at IS NULL THEN public.store_name_key(NEW.name) END;

  IF TG_OP = 'UPDATE' AND NEW.owner_id <> OLD.owner_id AND NOT public.store_is_privileged() THEN
    RAISE EXCEPTION 'store: a folder cannot change owner except through the re-home functions'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT public.store_is_privileged() THEN
    PERFORM public.store_lock_owner(NEW.owner_id);   -- serialise tree changes per owner
  END IF;

  IF NEW.parent_id IS NOT NULL THEN
    SELECT owner_id, trashed_at INTO v_parent FROM public.store_folders WHERE id = NEW.parent_id;
    IF v_parent.owner_id IS DISTINCT FROM NEW.owner_id AND NOT public.store_is_privileged() THEN
      RAISE EXCEPTION 'store: a folder must have the same owner as its parent' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.trashed_at IS NULL AND v_parent.trashed_at IS NOT NULL THEN
      RAISE EXCEPTION 'store: cannot place a live folder inside a trashed folder' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
      WITH RECURSIVE up(id, parent_id, depth) AS (
        SELECT f.id, f.parent_id, 1 FROM public.store_folders f WHERE f.id = NEW.parent_id
        UNION ALL
        SELECT f.id, f.parent_id, up.depth + 1 FROM public.store_folders f JOIN up ON f.id = up.parent_id
        WHERE up.depth < 10000
      )
      SELECT id INTO v_hit FROM up WHERE id = NEW.id LIMIT 1;
      IF v_hit IS NOT NULL THEN
        RAISE EXCEPTION 'store: moving this folder there would create a loop' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_store_folders_guard ON public.store_folders;
CREATE TRIGGER trg_store_folders_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.store_folders
  FOR EACH ROW EXECUTE FUNCTION public.store_folders_guard();

-- ─────────────────────────────────────────────────────────────── files + versions
CREATE TABLE IF NOT EXISTS public.store_files (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES public.store_owners(id) ON DELETE RESTRICT,
  folder_id           uuid NOT NULL REFERENCES public.store_folders(id) ON DELETE RESTRICT,
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 255 AND name !~ '[/\\[:cntrl:]]'),
  name_key            text,
  document_type       text,
  period_year         integer CHECK (period_year IS NULL OR period_year BETWEEN 1990 AND 2100),
  filing_status       text NOT NULL DEFAULT 'none' CHECK (filing_status IN ('none','draft','filed','amended')),
  supersedes_file_id  uuid REFERENCES public.store_files(id) ON DELETE RESTRICT,
  is_superseded       boolean NOT NULL DEFAULT false,
  proof_of_filing     boolean NOT NULL DEFAULT false,
  published           boolean NOT NULL DEFAULT false,
  current_version_id  uuid,
  caller_key          text,
  state               text NOT NULL DEFAULT 'live' CHECK (state IN ('live','trashed','purged')),
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  trashed_at          timestamptz,
  trashed_by          uuid,
  trash_batch_id      uuid,
  purged_at           timestamptz,
  CONSTRAINT store_files_state_shape CHECK (
       (state = 'live'    AND trashed_at IS NULL AND purged_at IS NULL AND name_key IS NOT NULL)
    OR (state = 'trashed' AND trashed_at IS NOT NULL AND purged_at IS NULL AND name_key IS NULL)
    OR (state = 'purged'  AND purged_at IS NOT NULL AND name_key IS NULL)
  ),
  CONSTRAINT store_files_not_self_superseding CHECK (supersedes_file_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX IF NOT EXISTS store_files_folder_name_uq ON public.store_files (folder_id, name_key);
CREATE UNIQUE INDEX IF NOT EXISTS store_files_caller_key_uq  ON public.store_files (owner_id, caller_key);
CREATE INDEX IF NOT EXISTS store_files_owner_idx     ON public.store_files (owner_id);
CREATE INDEX IF NOT EXISTS store_files_folder_idx    ON public.store_files (folder_id);
CREATE INDEX IF NOT EXISTS store_files_type_year_idx ON public.store_files (document_type, period_year);

CREATE TABLE IF NOT EXISTS public.store_file_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id        uuid NOT NULL REFERENCES public.store_files(id) ON DELETE RESTRICT,
  version_no     integer NOT NULL CHECK (version_no >= 1),
  storage_bucket text NOT NULL,
  storage_path   text NOT NULL,
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes     bigint NOT NULL CHECK (size_bytes >= 0),
  mime_type      text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  ocr_text       text,
  search         tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(ocr_text, ''))) STORED,
  UNIQUE (file_id, version_no),
  UNIQUE (storage_bucket, storage_path)
);
CREATE INDEX IF NOT EXISTS store_file_versions_sha_idx    ON public.store_file_versions (sha256);
CREATE INDEX IF NOT EXISTS store_file_versions_search_idx ON public.store_file_versions USING gin (search);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_files_current_version_fk') THEN
    ALTER TABLE public.store_files
      ADD CONSTRAINT store_files_current_version_fk FOREIGN KEY (current_version_id)
      REFERENCES public.store_file_versions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- saved versions are immutable: only the OCR text may be filled in later; deletes only in the purge
CREATE OR REPLACE FUNCTION public.store_file_versions_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT public.store_is_privileged() THEN
      RAISE EXCEPTION 'store: saved versions are never deleted (only the 90-day purge removes content)' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.file_id, NEW.version_no, NEW.storage_bucket, NEW.storage_path, NEW.sha256, NEW.size_bytes, NEW.mime_type, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.file_id, OLD.version_no, OLD.storage_bucket, OLD.storage_path, OLD.sha256, OLD.size_bytes, OLD.mime_type, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'store: a saved version never changes — save a new version instead' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_store_file_versions_guard ON public.store_file_versions;
CREATE TRIGGER trg_store_file_versions_guard
  BEFORE UPDATE OR DELETE ON public.store_file_versions
  FOR EACH ROW EXECUTE FUNCTION public.store_file_versions_guard();

CREATE OR REPLACE FUNCTION public.store_files_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_folder record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'store: files are never deleted — a purged file stays as a permanent tombstone' USING ERRCODE = 'check_violation';
  END IF;

  NEW.updated_at := now();
  NEW.name_key := CASE WHEN NEW.state = 'live' THEN public.store_name_key(NEW.name) END;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.owner_id <> OLD.owner_id AND NOT public.store_is_privileged() THEN
      RAISE EXCEPTION 'store: a file cannot change owner except through the re-home functions'
        USING ERRCODE = 'check_violation';
    END IF;
    -- tombstones are permanent; the only allowed change is its owner inside a privileged re-home
    IF OLD.state = 'purged' AND (
         NOT public.store_is_privileged()
         OR (to_jsonb(NEW) - 'owner_id' - 'updated_at' - 'name_key') IS DISTINCT FROM (to_jsonb(OLD) - 'owner_id' - 'updated_at' - 'name_key')
       ) THEN
      RAISE EXCEPTION 'store: a purged file is a permanent tombstone' USING ERRCODE = 'check_violation';
    END IF;
    -- frozen: a filed file never takes a new version and never leaves "filed" except to "amended"
    IF OLD.filing_status = 'filed' AND NEW.state <> 'purged' AND NOT public.store_is_privileged() THEN
      IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
        RAISE EXCEPTION 'store: this file is filed and frozen — save an amended file instead' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.filing_status NOT IN ('filed','amended') THEN
        RAISE EXCEPTION 'store: a filed file cannot be un-filed' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NOT public.store_is_privileged() THEN
    PERFORM public.store_lock_owner(NEW.owner_id);
  END IF;

  SELECT owner_id, trashed_at INTO v_folder FROM public.store_folders WHERE id = NEW.folder_id;
  IF v_folder.owner_id IS DISTINCT FROM NEW.owner_id THEN
    RAISE EXCEPTION 'store: a file must have the same owner as its folder' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'live' AND v_folder.trashed_at IS NOT NULL THEN
    RAISE EXCEPTION 'store: cannot keep a live file inside a trashed folder' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_store_files_guard ON public.store_files;
CREATE TRIGGER trg_store_files_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.store_files
  FOR EACH ROW EXECUTE FUNCTION public.store_files_guard();

-- ─────────────────────────────────────────────────────────────── links, subjects, tags, facts
CREATE TABLE IF NOT EXISTS public.store_record_links (
  file_id            uuid NOT NULL REFERENCES public.store_files(id) ON DELETE RESTRICT,
  link_kind          text NOT NULL,
  record_id          uuid NOT NULL,
  stage_at_creation  text,
  tax_year           integer,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, link_kind, record_id)
);
CREATE INDEX IF NOT EXISTS store_record_links_record_idx ON public.store_record_links (link_kind, record_id);

CREATE TABLE IF NOT EXISTS public.store_file_subjects (
  file_id       uuid NOT NULL REFERENCES public.store_files(id) ON DELETE RESTRICT,
  subject_kind  text NOT NULL CHECK (subject_kind IN ('person','company')),
  contact_id    uuid REFERENCES public.contacts(id) ON DELETE RESTRICT,
  account_id    uuid REFERENCES public.accounts(id) ON DELETE RESTRICT,
  role          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_file_subjects_shape CHECK (
       (subject_kind = 'person'  AND contact_id IS NOT NULL AND account_id IS NULL)
    OR (subject_kind = 'company' AND account_id IS NOT NULL AND contact_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS store_file_subjects_uq
  ON public.store_file_subjects (file_id, subject_kind, coalesce(contact_id, account_id), role);

CREATE TABLE IF NOT EXISTS public.store_file_tags (
  file_id     uuid NOT NULL REFERENCES public.store_files(id) ON DELETE RESTRICT,
  tag         text NOT NULL,
  source      text NOT NULL CHECK (source IN ('human','rule','ai')),
  version_id  uuid REFERENCES public.store_file_versions(id) ON DELETE RESTRICT,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, tag)
);

CREATE TABLE IF NOT EXISTS public.store_file_facts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id       uuid NOT NULL REFERENCES public.store_files(id) ON DELETE RESTRICT,
  key           text NOT NULL,
  value         text NOT NULL,
  source        text NOT NULL CHECK (source IN ('human','rule','ai')),
  version_id    uuid REFERENCES public.store_file_versions(id) ON DELETE RESTRICT,
  confirmed_by  uuid,
  confirmed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_file_facts_file_idx ON public.store_file_facts (file_id, key);

-- ─────────────────────────────────────────────────────────────── events (append-only)
CREATE TABLE IF NOT EXISTS public.store_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  event           text NOT NULL,
  actor           uuid,
  owner_id        uuid,
  file_id         uuid,
  folder_id       uuid,
  name_snapshot   text,
  recipient_class text,
  reason          text,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS store_events_file_idx  ON public.store_events (file_id, occurred_at);
CREATE INDEX IF NOT EXISTS store_events_owner_idx ON public.store_events (owner_id, occurred_at);

CREATE OR REPLACE FUNCTION public.store_events_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'store: history is append-only' USING ERRCODE = 'check_violation';
END $$;
DROP TRIGGER IF EXISTS trg_store_events_append_only ON public.store_events;
CREATE TRIGGER trg_store_events_append_only
  BEFORE UPDATE OR DELETE ON public.store_events
  FOR EACH ROW EXECUTE FUNCTION public.store_events_append_only();
DROP TRIGGER IF EXISTS trg_store_events_no_truncate ON public.store_events;
CREATE TRIGGER trg_store_events_no_truncate
  BEFORE TRUNCATE ON public.store_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.store_events_append_only();

-- ─────────────────────────────────────────────────────────────── external references (Drive ids live ONLY here)
CREATE TABLE IF NOT EXISTS public.store_external_refs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_kind       text NOT NULL CHECK (object_kind IN ('folder','file','file_version')),
  object_id         uuid NOT NULL,
  provider          text NOT NULL DEFAULT 'gdrive',
  direction         text NOT NULL CHECK (direction IN ('import','backup')),
  external_id       text NOT NULL,
  status            text NOT NULL DEFAULT 'pending',
  backed_up_sha256  text,
  drive_path        jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_checked_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, direction, external_id),
  UNIQUE (object_kind, object_id, provider, direction)
);

-- ─────────────────────────────────────────────────────────────── owner functions
-- Formation attach (defined first: store_ensure_owner calls it). When Articles create the
-- real company, the company TAKES OVER the in-formation owner row in place (same folders
-- and files, no second template), keyed on the service case the create-company step
-- actually linked. Idempotent. Renames the root to the company's final name.
CREATE OR REPLACE FUNCTION public.store_attach_formation(p_service_delivery_id uuid, p_account_id uuid, p_actor uuid DEFAULT NULL, p_company_name text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_owner record;
  v_existing uuid;
BEGIN
  IF p_service_delivery_id IS NULL OR p_account_id IS NULL THEN
    RAISE EXCEPTION 'store: attach needs both the formation service case and the company (no guessing)';
  END IF;
  SELECT * INTO v_owner FROM public.store_owners WHERE service_delivery_id = p_service_delivery_id FOR UPDATE;
  IF v_owner.id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_owner.kind = 'company' THEN
    IF v_owner.account_id = p_account_id THEN RETURN v_owner.id; END IF;
    RAISE EXCEPTION 'store: formation % is already attached to another company', p_service_delivery_id;
  END IF;
  IF v_owner.lifecycle_override = 'archived' THEN
    RAISE EXCEPTION 'store: formation % was cancelled — reactivate it before attaching', p_service_delivery_id;
  END IF;
  SELECT id INTO v_existing FROM public.store_owners WHERE account_id = p_account_id;
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'store: company % already has its own storage — needs a staff merge, not an automatic attach', p_account_id;
  END IF;

  PERFORM public.store_lock_owner(v_owner.id);
  UPDATE public.store_owners
     SET kind = 'company', account_id = p_account_id, lifecycle_override = NULL, updated_at = now()
   WHERE id = v_owner.id;
  IF p_company_name IS NOT NULL AND btrim(p_company_name) <> '' THEN
    UPDATE public.store_folders SET name = p_company_name WHERE owner_id = v_owner.id AND parent_id IS NULL;
  END IF;

  INSERT INTO public.store_events (event, actor, owner_id, reason, details)
  VALUES ('formation_attached', p_actor, v_owner.id, 'Articles received — company created',
          jsonb_build_object('service_delivery_id', p_service_delivery_id, 'account_id', p_account_id));
  RETURN v_owner.id;
END $$;

-- Get-or-create an owner (lazily — only when something is about to be stored).
-- Company: if an in-formation owner exists for a service case now linked to this account,
-- it is ATTACHED instead of creating a second owner. Formation: if the case already has a
-- company, returns that company's owner.
CREATE OR REPLACE FUNCTION public.store_ensure_owner(p_kind text, p_ref uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
  v_sd_account uuid;
  v_formation uuid;
BEGIN
  IF p_ref IS NULL AND p_kind <> 'unfiled' THEN RAISE EXCEPTION 'store: owner reference required'; END IF;
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
  ELSIF p_kind = 'unfiled' THEN
    SELECT id INTO v_id FROM public.store_owners WHERE kind = 'unfiled';
    IF v_id IS NULL THEN
      INSERT INTO public.store_owners (kind) VALUES ('unfiled') RETURNING id INTO v_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'store: unknown owner kind %', p_kind;
  END IF;
  RETURN v_id;
END $$;

-- Create the owner's folder tree from a catalog template. Idempotent, serialised per owner.
CREATE OR REPLACE FUNCTION public.store_apply_template_children(p_owner_id uuid, p_parent uuid, p_nodes jsonb, p_template_slug text, p_actor uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  n jsonb;
  v_id uuid;
BEGIN
  FOR n IN SELECT * FROM jsonb_array_elements(p_nodes) LOOP
    SELECT id INTO v_id FROM public.store_folders
     WHERE owner_id = p_owner_id AND parent_id = p_parent AND name_key = public.store_name_key(n->>'name');
    IF v_id IS NULL THEN
      INSERT INTO public.store_folders (owner_id, parent_id, kind, template_slug, name, created_by)
      VALUES (p_owner_id, p_parent, n->>'kind', p_template_slug, n->>'name', p_actor) RETURNING id INTO v_id;
    END IF;
    IF n ? 'children' THEN
      PERFORM public.store_apply_template_children(p_owner_id, v_id, n->'children', p_template_slug, p_actor);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.store_apply_template(p_owner_id uuid, p_template_slug text, p_root_name text, p_actor uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_meta jsonb;
  v_root uuid;
  v_kind text;
BEGIN
  PERFORM public.store_lock_owner(p_owner_id);
  SELECT kind INTO v_kind FROM public.store_owners WHERE id = p_owner_id;
  IF v_kind IS NULL THEN RAISE EXCEPTION 'store: owner % not found', p_owner_id; END IF;
  SELECT metadata INTO v_meta FROM public.catalog_entries
   WHERE catalog_id = 'storage_folder_templates' AND slug = p_template_slug AND status = 'active';
  IF v_meta IS NULL THEN RAISE EXCEPTION 'store: unknown or inactive folder template %', p_template_slug; END IF;
  IF NOT (coalesce(v_meta->'owner_kinds', '[]'::jsonb) ? v_kind) THEN
    RAISE EXCEPTION 'store: template % is not for % owners', p_template_slug, v_kind;
  END IF;

  SELECT id INTO v_root FROM public.store_folders WHERE owner_id = p_owner_id AND parent_id IS NULL;
  IF v_root IS NULL THEN
    INSERT INTO public.store_folders (owner_id, parent_id, kind, template_slug, name, created_by)
    VALUES (p_owner_id, NULL, coalesce(v_meta->>'root_kind', 'root'), p_template_slug, p_root_name, p_actor) RETURNING id INTO v_root;
  END IF;
  PERFORM public.store_apply_template_children(p_owner_id, v_root, coalesce(v_meta->'folders', '[]'::jsonb), p_template_slug, p_actor);
  RETURN v_root;
END $$;

-- The only sanctioned cross-owner move of a folder subtree.
CREATE OR REPLACE FUNCTION public.store_rehome_subtree(p_folder_id uuid, p_to_owner uuid, p_to_parent uuid, p_actor uuid, p_reason text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_from_owner uuid;
  v_count integer;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'store: a re-home needs a reason'; END IF;
  SELECT owner_id INTO v_from_owner FROM public.store_folders WHERE id = p_folder_id;
  IF v_from_owner IS NULL THEN RAISE EXCEPTION 'store: folder % not found', p_folder_id; END IF;
  IF p_to_owner = v_from_owner THEN RAISE EXCEPTION 'store: re-home is only for moving to another owner'; END IF;
  PERFORM public.store_lock_owner(least(v_from_owner, p_to_owner));
  PERFORM public.store_lock_owner(greatest(v_from_owner, p_to_owner));
  IF p_to_parent IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.store_folders WHERE id = p_to_parent AND owner_id = p_to_owner AND trashed_at IS NULL) THEN
    RAISE EXCEPTION 'store: target folder must be a live folder of the new owner';
  END IF;

  PERFORM set_config('store.privileged', 'on', true);
  WITH RECURSIVE sub(id) AS (
    SELECT p_folder_id
    UNION ALL
    SELECT f.id FROM public.store_folders f JOIN sub ON f.parent_id = sub.id
  )
  UPDATE public.store_folders f SET owner_id = p_to_owner,
         parent_id = CASE WHEN f.id = p_folder_id THEN p_to_parent ELSE f.parent_id END
   WHERE f.id IN (SELECT id FROM sub);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE public.store_files SET owner_id = p_to_owner
   WHERE folder_id IN (WITH RECURSIVE sub(id) AS (
      SELECT p_folder_id UNION ALL SELECT f.id FROM public.store_folders f JOIN sub ON f.parent_id = sub.id)
    SELECT id FROM sub);
  PERFORM set_config('store.privileged', 'off', true);

  INSERT INTO public.store_events (event, actor, owner_id, folder_id, reason, details)
  VALUES ('rehomed', p_actor, p_to_owner, p_folder_id, p_reason, jsonb_build_object('from_owner', v_from_owner, 'folders', v_count));
  RETURN v_count;
END $$;

-- The only sanctioned cross-owner move of a single file (e.g. an Unfiled letter classified).
CREATE OR REPLACE FUNCTION public.store_rehome_file(p_file_id uuid, p_to_folder uuid, p_actor uuid, p_reason text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_file record;
  v_to_owner uuid;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'store: a re-home needs a reason'; END IF;
  SELECT id, owner_id, name, state INTO v_file FROM public.store_files WHERE id = p_file_id;
  IF v_file.id IS NULL THEN RAISE EXCEPTION 'store: file % not found', p_file_id; END IF;
  IF v_file.state <> 'live' THEN RAISE EXCEPTION 'store: only a live file can be re-homed'; END IF;
  SELECT owner_id INTO v_to_owner FROM public.store_folders WHERE id = p_to_folder AND trashed_at IS NULL;
  IF v_to_owner IS NULL THEN RAISE EXCEPTION 'store: target folder must be live'; END IF;
  IF v_to_owner = v_file.owner_id THEN RAISE EXCEPTION 'store: same owner — use a normal move'; END IF;
  PERFORM public.store_lock_owner(least(v_file.owner_id, v_to_owner));
  PERFORM public.store_lock_owner(greatest(v_file.owner_id, v_to_owner));

  PERFORM set_config('store.privileged', 'on', true);
  UPDATE public.store_files SET owner_id = v_to_owner, folder_id = p_to_folder WHERE id = p_file_id;
  PERFORM set_config('store.privileged', 'off', true);

  INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot, reason, details)
  VALUES ('rehomed', p_actor, v_to_owner, p_file_id, p_to_folder, v_file.name, p_reason, jsonb_build_object('from_owner', v_file.owner_id));
END $$;

-- Who appears in a company's "2. Contacts" view: company–person links whose normalised role
-- maps (catalog storage_contact_roles) to appears_in_contacts, not ended. A company whose
-- only live link has no role treats that person as the owner (single-member LLC). One row
-- per person.
CREATE OR REPLACE FUNCTION public.store_company_contacts(p_account_id uuid)
RETURNS TABLE (contact_id uuid, role_slug text) LANGUAGE sql STABLE AS $$
  WITH links AS (
    SELECT ac.contact_id, public.store_role_key(ac.role) AS rk
      FROM public.account_contacts ac
     WHERE ac.account_id = p_account_id AND ac.ended_at IS NULL
  ), only_link AS (
    SELECT count(*) = 1 AS single FROM links
  ), mapped AS (
    SELECT l.contact_id,
           coalesce(r.slug, CASE WHEN l.rk = '' AND (SELECT single FROM only_link) THEN 'owner' END) AS role_slug
      FROM links l
      LEFT JOIN public.catalog_entries r
        ON r.catalog_id = 'storage_contact_roles' AND r.status = 'active' AND r.metadata->'matches' ? l.rk
  )
  SELECT DISTINCT ON (m.contact_id) m.contact_id, m.role_slug
    FROM mapped m
    JOIN public.catalog_entries c
      ON c.catalog_id = 'storage_contact_roles' AND c.slug = m.role_slug
     AND coalesce((c.metadata->>'appears_in_contacts')::boolean, false)
   ORDER BY m.contact_id, m.role_slug
$$;

-- Raw roles that map to nothing — a staff report so no one silently drops out.
CREATE OR REPLACE FUNCTION public.store_unmatched_contact_roles()
RETURNS TABLE (raw_role text, links bigint) LANGUAGE sql STABLE AS $$
  SELECT coalesce(ac.role, '(none)'), count(*)
    FROM public.account_contacts ac
   WHERE ac.ended_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.catalog_entries r
                      WHERE r.catalog_id = 'storage_contact_roles' AND r.status = 'active'
                        AND r.metadata->'matches' ? public.store_role_key(ac.role))
   GROUP BY 1 ORDER BY 2 DESC
$$;

-- ─────────────────────────────────────────────────────────────── CRM records that hold files cannot be deleted
CREATE OR REPLACE FUNCTION public.store_refuse_delete_if_linked()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.store_record_links WHERE link_kind = TG_ARGV[0] AND record_id = OLD.id)
     OR (TG_ARGV[0] = 'service_case' AND EXISTS (SELECT 1 FROM public.store_owners WHERE service_delivery_id = OLD.id)) THEN
    RAISE EXCEPTION 'This record has stored documents linked to it and cannot be deleted. Move or unlink its documents first.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS trg_store_protect_service_deliveries ON public.service_deliveries;
CREATE TRIGGER trg_store_protect_service_deliveries BEFORE DELETE ON public.service_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.store_refuse_delete_if_linked('service_case');
DROP TRIGGER IF EXISTS trg_store_protect_tax_returns ON public.tax_returns;
CREATE TRIGGER trg_store_protect_tax_returns BEFORE DELETE ON public.tax_returns
  FOR EACH ROW EXECUTE FUNCTION public.store_refuse_delete_if_linked('tax_return');
DROP TRIGGER IF EXISTS trg_store_protect_signature_requests ON public.signature_requests;
CREATE TRIGGER trg_store_protect_signature_requests BEFORE DELETE ON public.signature_requests
  FOR EACH ROW EXECUTE FUNCTION public.store_refuse_delete_if_linked('signature_request');
DROP TRIGGER IF EXISTS trg_store_protect_esign_envelopes ON public.esign_envelopes;
CREATE TRIGGER trg_store_protect_esign_envelopes BEFORE DELETE ON public.esign_envelopes
  FOR EACH ROW EXECUTE FUNCTION public.store_refuse_delete_if_linked('esign_envelope');

-- ─────────────────────────────────────────────────────────────── access: service role only
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['store_owners','store_folders','store_files','store_file_versions','store_record_links',
                           'store_file_subjects','store_file_tags','store_file_facts','store_events','store_external_refs']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated, PUBLIC', t);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.store_ensure_owner(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_apply_template(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_apply_template_children(uuid, uuid, jsonb, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_rehome_subtree(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_rehome_file(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_attach_formation(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_company_contacts(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_unmatched_contact_roles() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_lock_owner(uuid) FROM PUBLIC, anon, authenticated;

INSERT INTO storage.buckets (id, name, public) VALUES ('crm-store', 'crm-store', false)
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────── catalogs (business data, editable without a deploy)
INSERT INTO public.catalog_definitions (id, display_name, description, admin_can_add_rows)
SELECT v.id, v.display_name, v.description, true
FROM (VALUES
  ('storage_folder_kinds',      'Storage — folder kinds',        'Kinds of folders in the CRM store. metadata: accepts_files(bool), personal_only(bool), shown_through_company(bool), virtual_view, sort_order.'),
  ('storage_folder_templates',  'Storage — folder templates',    'Folder trees created for an owner. metadata: owner_kinds[], root_kind, folders[{name,kind,children[]}].'),
  ('storage_document_types',    'Storage — document types',      'Editable document types (seeded from document_types). metadata: legacy_document_type_id, default_folder_kind, personal(bool), default_published(bool), draft_never_visible(bool), freeze_when_filed(bool), proof_of_filing(bool).'),
  ('storage_subject_roles',     'Storage — file subject roles',  'Who a file concerns and how. metadata: subject_kinds[].'),
  ('storage_contact_roles',     'Storage — company–person roles','Normalises the free-text account_contacts.role (lowercased, whitespace/underscores collapsed). metadata: matches[], appears_in_contacts(bool), portal_audience(bool), recipient_class.'),
  ('storage_link_kinds',        'Storage — record link kinds',   'CRM records a file can be linked to. metadata: table (or code_only).'),
  ('storage_lifecycle_map',     'Storage — CRM status → storage lifecycle', 'Maps accounts.status to active/archived at read time. metadata: account_status, lifecycle, portal_visible(bool).'),
  ('storage_client_safe_stages','Storage — client-safe stages',  'Per service type, the stages whose files the client may see. metadata: service_type, stages[].'),
  ('storage_recipient_classes', 'Storage — send recipient classes', 'Who a file can be sent to. metadata: personal_files_allowed(bool), needs_reason(bool).')
) AS v(id, display_name, description)
WHERE NOT EXISTS (SELECT 1 FROM public.catalog_definitions d WHERE d.id = v.id);

INSERT INTO public.catalog_entries (catalog_id, slug, display_name, status, metadata)
SELECT v.catalog_id, v.slug, v.display_name, 'active', v.metadata::jsonb
FROM (VALUES
  ('storage_folder_kinds','root',            'Owner root',        '{"accepts_files":false,"sort_order":0}'),
  ('storage_folder_kinds','company',         '1. Company',        '{"accepts_files":true,"sort_order":10}'),
  ('storage_folder_kinds','contacts',        '2. Contacts',       '{"accepts_files":false,"virtual_view":"company_contacts","sort_order":20}'),
  ('storage_folder_kinds','tax',             '3. Tax',            '{"accepts_files":true,"sort_order":30}'),
  ('storage_folder_kinds','tax_year',        'Tax year',          '{"accepts_files":true,"sort_order":31}'),
  ('storage_folder_kinds','banking',         '4. Banking',        '{"accepts_files":true,"sort_order":40}'),
  ('storage_folder_kinds','correspondence',  '5. Correspondence', '{"accepts_files":true,"sort_order":50}'),
  ('storage_folder_kinds','personal',        'Personal documents','{"accepts_files":true,"personal_only":true,"shown_through_company":true,"sort_order":60}'),
  ('storage_folder_kinds','itin',            'ITIN',              '{"accepts_files":true,"personal_only":true,"shown_through_company":false,"sort_order":70}'),
  ('storage_folder_kinds','person_tax',      'Personal tax',      '{"accepts_files":true,"personal_only":true,"shown_through_company":false,"sort_order":80}'),
  ('storage_folder_kinds','person_tax_year', 'Personal tax year', '{"accepts_files":true,"personal_only":true,"shown_through_company":false,"sort_order":81}'),
  ('storage_folder_kinds','unfiled',         'Unfiled',           '{"accepts_files":true,"sort_order":90}'),
  ('storage_folder_kinds','custom',          'Custom folder',     '{"accepts_files":true,"sort_order":100}'),
  ('storage_folder_templates','company_standard','Company — standard five folders',
     '{"owner_kinds":["company","formation"],"root_kind":"root","folders":[{"name":"1. Company","kind":"company"},{"name":"2. Contacts","kind":"contacts"},{"name":"3. Tax","kind":"tax"},{"name":"4. Banking","kind":"banking"},{"name":"5. Correspondence","kind":"correspondence"}]}'),
  ('storage_folder_templates','person_standard','Person — personal folder',
     '{"owner_kinds":["person"],"root_kind":"root","folders":[{"name":"Personal documents","kind":"personal"},{"name":"ITIN","kind":"itin"},{"name":"Tax","kind":"person_tax"}]}'),
  ('storage_folder_templates','unfiled_standard','Unfiled intake',
     '{"owner_kinds":["unfiled"],"root_kind":"unfiled","folders":[]}'),
  ('storage_subject_roles','owner_member',   'Owner / member',   '{"subject_kinds":["person","company"]}'),
  ('storage_subject_roles','signer',         'Signer',           '{"subject_kinds":["person"]}'),
  ('storage_subject_roles','counterparty',   'Counterparty',     '{"subject_kinds":["person","company"]}'),
  ('storage_subject_roles','concerns',       'Concerns',         '{"subject_kinds":["person","company"]}'),
  ('storage_contact_roles','owner',          'Owner',            '{"matches":["owner","sole member"],"appears_in_contacts":true,"portal_audience":true,"recipient_class":"company_members"}'),
  ('storage_contact_roles','member',         'Member',           '{"matches":["member"],"appears_in_contacts":true,"portal_audience":true,"recipient_class":"company_members"}'),
  ('storage_contact_roles','representative', 'Representative',   '{"matches":["authorized representative"],"appears_in_contacts":false,"portal_audience":true,"recipient_class":"representative"}'),
  ('storage_contact_roles','collaborator',   'Collaborator',     '{"matches":[],"appears_in_contacts":false,"portal_audience":false,"recipient_class":"other"}'),
  ('storage_contact_roles','consultant',     'Consultant',       '{"matches":[],"appears_in_contacts":false,"portal_audience":false,"recipient_class":"other"}'),
  ('storage_link_kinds','service_case',      'Service case',     '{"table":"service_deliveries"}'),
  ('storage_link_kinds','tax_return',        'Tax return',       '{"table":"tax_returns"}'),
  ('storage_link_kinds','signature_request', 'Signature request','{"table":"signature_requests"}'),
  ('storage_link_kinds','esign_envelope',    'E-sign envelope',  '{"table":"esign_envelopes"}'),
  ('storage_link_kinds','fax_transmission',  'Fax transmission', '{"code_only":"lib/fax — no fax table today; record_id is the stored receipt file"}'),
  ('storage_lifecycle_map','active',         'Active',           '{"account_status":"Active","lifecycle":"active","portal_visible":true}'),
  ('storage_lifecycle_map','suspended',      'Suspended',        '{"account_status":"Suspended","lifecycle":"active","portal_visible":true}'),
  ('storage_lifecycle_map','delinquent',     'Delinquent',       '{"account_status":"Delinquent","lifecycle":"active","portal_visible":false}'),
  ('storage_lifecycle_map','pending_formation','Pending Formation','{"account_status":"Pending Formation","lifecycle":"active","portal_visible":false}'),
  ('storage_lifecycle_map','offboarding',    'Offboarding',      '{"account_status":"Offboarding","lifecycle":"archived","portal_visible":false}'),
  ('storage_lifecycle_map','cancelled',      'Cancelled',        '{"account_status":"Cancelled","lifecycle":"archived","portal_visible":false}'),
  ('storage_lifecycle_map','closed',         'Closed',           '{"account_status":"Closed","lifecycle":"archived","portal_visible":false}'),
  ('storage_client_safe_stages','company_formation','Company Formation','{"service_type":"Company Formation","stages":["Filed with State","Articles Received","EIN Received","Signed"]}'),
  ('storage_client_safe_stages','state_annual_report','State Annual Report','{"service_type":"State Annual Report","stages":["Due Date","Filed","Filing Receipt Uploaded"]}'),
  ('storage_client_safe_stages','state_ra_renewal','State RA Renewal','{"service_type":"State RA Renewal","stages":["Renewal Due","Renewal Processed","Document Uploaded"]}'),
  ('storage_client_safe_stages','tax_return','Tax Return','{"service_type":"Tax Return","stages":["Extension Due","Filed with IRS","IRS Receipt Uploaded","Signed","Completed"]}'),
  ('storage_client_safe_stages','cmra_mailing_address','CMRA Mailing Address','{"service_type":"CMRA Mailing Address","stages":["Lease Signed","CMRA Active"]}'),
  ('storage_recipient_classes','own_person',     'The person themself', '{"personal_files_allowed":true,"needs_reason":false}'),
  ('storage_recipient_classes','company_members','Company owners & members','{"personal_files_allowed":false,"needs_reason":false}'),
  ('storage_recipient_classes','representative', 'A member''s representative','{"personal_files_allowed":false,"needs_reason":false}'),
  ('storage_recipient_classes','tax_authority',  'Tax authority (IRS, state)','{"personal_files_allowed":true,"needs_reason":true}'),
  ('storage_recipient_classes','accountant',     'The accountant',      '{"personal_files_allowed":true,"needs_reason":true}'),
  ('storage_recipient_classes','india_team',     'The India team',      '{"personal_files_allowed":true,"needs_reason":true}'),
  ('storage_recipient_classes','bank',           'A bank',              '{"personal_files_allowed":true,"needs_reason":true}'),
  ('storage_recipient_classes','other',          'Other',               '{"personal_files_allowed":false,"needs_reason":true}')
) AS v(catalog_id, slug, display_name, metadata)
WHERE NOT EXISTS (SELECT 1 FROM public.catalog_entries c WHERE c.catalog_id = v.catalog_id AND c.slug = v.slug);

-- Document types, seeded from the existing 42-row document_types list (identical in
-- sandbox and production, verified 2026-09-24). Personal types are an EXPLICIT list:
-- the person's own ID papers, ITIN papers and own 1040-NR. Everything else — including
-- the company tax returns with K-1s and the SS-4 — is a company document visible to all
-- members (Antonio #38, #39, #43, #45).
DO $$
DECLARE
  v_personal text[] := ARRAY['Passport','ID Document','Proof of Address','Utility Bill','ITIN Letter','Form W-7','Form 1040-NR'];
  v_draft    text[] := ARRAY['Tax Return','Form 1065','Form 1120','Form 1120-F','Form 5472','Form 1040-NR'];
  v_freeze   text[] := ARRAY['Tax Return','Form 1065','Form 1120','Form 1120-F','Form 5472','Form 1040-NR','Form 7004',
                             'Form 8804-8805 (Partnership Withholding)','Form W-7','Annual Report','Articles of Organization',
                             'Articles of Incorporation','Certificate of Dissolution','BOI Report'];
  v_proof    text[] := ARRAY['IRS E-File Acknowledgment','Fax Confirmation','Receipt'];
  v_missing  text;
  v_seeded   int;
  v_total    int;
BEGIN
  SELECT string_agg(n, ', ') INTO v_missing
    FROM unnest(v_personal || v_draft || v_freeze || v_proof) n
   WHERE NOT EXISTS (SELECT 1 FROM public.document_types dt WHERE dt.type_name = n);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'store seed: document types not found: %', v_missing;
  END IF;

  INSERT INTO public.catalog_entries (catalog_id, slug, display_name, status, metadata)
  SELECT 'storage_document_types', s.slug, s.type_name,
         CASE WHEN s.is_active THEN 'active' ELSE 'deprecated' END,
         jsonb_build_object(
           'legacy_document_type_id', s.id,
           'legacy_category', s.category,
           'suggested_folder', s.suggested_folder,
           'default_folder_kind', CASE WHEN s.type_name = ANY(ARRAY['ITIN Letter','Form W-7']) THEN 'itin'
                                       WHEN s.type_name = 'Form 1040-NR' THEN 'person_tax_year'
                                       WHEN s.type_name = ANY(v_personal) THEN 'personal'
                                       ELSE CASE s.category WHEN 1 THEN 'company' WHEN 2 THEN 'company' WHEN 3 THEN 'tax_year'
                                                            WHEN 4 THEN 'banking' ELSE 'correspondence' END END,
           'personal', s.type_name = ANY(v_personal),
           'default_published', false,
           'draft_never_visible', s.type_name = ANY(v_draft),
           'freeze_when_filed', s.type_name = ANY(v_freeze),
           'proof_of_filing', s.type_name = ANY(v_proof))
    FROM (SELECT dt.*, btrim(regexp_replace(lower(dt.type_name), '[^a-z0-9]+', '_', 'g'), '_') AS slug
            FROM public.document_types dt) s
   WHERE s.slug <> ''
     AND NOT EXISTS (SELECT 1 FROM public.catalog_entries c WHERE c.catalog_id = 'storage_document_types' AND c.slug = s.slug);

  SELECT count(*) INTO v_seeded FROM public.catalog_entries
   WHERE catalog_id = 'storage_document_types' AND metadata ? 'legacy_document_type_id';
  SELECT count(*) INTO v_total FROM public.document_types;
  IF v_seeded <> v_total THEN
    RAISE EXCEPTION 'store seed: % document types but % catalog rows — a slug collided or was empty', v_total, v_seeded;
  END IF;
END $$;

INSERT INTO public.catalog_entries (catalog_id, slug, display_name, status, metadata)
SELECT 'storage_document_types', 'irs_notice_personal', 'IRS Notice (personal)', 'active',
       '{"default_folder_kind":"person_tax","personal":true,"default_published":false,"draft_never_visible":false,"freeze_when_filed":false,"proof_of_filing":false}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.catalog_entries c WHERE c.catalog_id = 'storage_document_types' AND c.slug = 'irs_notice_personal');

COMMIT;
