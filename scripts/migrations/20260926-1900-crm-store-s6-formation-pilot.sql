-- CRM Store — slice 6: the Formation pilot (master plan v4.5 §8.9 #6, job 685467b5). SANDBOX ONLY.
-- Requires slices 1–5 (20260924-2300 … 20260926-0900).
--
-- 1. "staff_only" document types: a file of such a type is NEVER shown to a client — whatever its
--    published flag or filing status — and publishing it is refused. Used ONLY for the Formation
--    Summary (it holds every member's date of birth, passport number and address). NOT for the SS-4,
--    its fax confirmation or the IRS package: Antonio reversed the "SS-4 never to the client" rule on
--    2026-08-04 ("the SS4 visible to the client is ok") — those stay unpublished by default (as today's
--    portal) but staff may share them.
-- 2. New document type formation_summary (staff-only).
-- 3. Cancelled formation → its in-formation storage is archived; reactivated → back to in formation.
--    A trigger on service_deliveries catches every way a status changes (the CRM action, the MCP tool and
--    the ~14 raw writers). It only touches owners of kind 'formation' (an attached company owner keeps its
--    service_delivery_id and must never go back to "in formation"), only on a real status change, and it
--    can NEVER block the CRM's own status write (errors are logged, not raised).
-- 3b. store_attach_formation() now refuses a company the formation case is not linked to.
-- 5. One CRM documents row per store file (unique index on store: pointers).
-- 4. store_rename_root(): the idempotent "give the company's root folder its final name" step, separate
--    from the attach so a company owner created early (auto-attach, no name) still gets its name.

BEGIN;

-- ─────────────────────────────────────────────────────────────── 1. staff-only types
CREATE OR REPLACE FUNCTION public.store_type_staff_only(p_document_type text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT (t.metadata->>'staff_only')::boolean FROM public.catalog_entries t
                    WHERE t.catalog_id = 'storage_document_types' AND t.slug = p_document_type), false)
$$;

-- On its own: live, published, not a draft of a "draft never visible" type, and not a staff-only type.
CREATE OR REPLACE FUNCTION public.store_file_self_visible(p_file_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT f.state = 'live' AND f.published
           AND NOT public.store_type_staff_only(f.document_type)
           AND NOT (f.filing_status = 'draft' AND coalesce((
                 SELECT (t.metadata->>'draft_never_visible')::boolean FROM public.catalog_entries t
                  WHERE t.catalog_id = 'storage_document_types' AND t.slug = f.document_type), false))
      FROM public.store_files f WHERE f.id = p_file_id), false)
$$;

CREATE OR REPLACE FUNCTION public.store_set_published(p_file_id uuid, p_published boolean, p_actor uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  f record;
BEGIN
  SELECT id, owner_id, folder_id, name, state, published, filing_status, document_type INTO f
    FROM public.store_files WHERE id = p_file_id FOR UPDATE;
  IF NOT FOUND OR f.state <> 'live' THEN RAISE EXCEPTION 'store: only a live file can be published or unpublished'; END IF;
  IF p_published AND public.store_type_staff_only(f.document_type) THEN
    RAISE EXCEPTION 'store: this document type is staff-only and is never shown to clients'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_published AND f.filing_status = 'draft' AND coalesce((
       SELECT (metadata->>'draft_never_visible')::boolean FROM public.catalog_entries
        WHERE catalog_id = 'storage_document_types' AND slug = f.document_type), false) THEN
    RAISE EXCEPTION 'store: a draft of this document type is never shown to clients — save the signed copy or mark it filed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF f.published = p_published THEN RETURN false; END IF;
  UPDATE public.store_files SET published = p_published WHERE id = p_file_id;
  INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot)
  VALUES (CASE WHEN p_published THEN 'published' ELSE 'unpublished' END, p_actor, f.owner_id, f.id, f.folder_id, f.name);
  RETURN true;
END $$;

-- (an earlier sandbox apply of this file flagged the SS-4 types staff-only; that contradicted Antonio's
-- 2026-08-04 rule and is undone here — a no-op wherever the flag was never set)
UPDATE public.catalog_entries
   SET metadata = metadata - 'staff_only', updated_at = now()
 WHERE catalog_id = 'storage_document_types' AND slug IN ('form_ss_4', 'fax_confirmation', 'irs_fax')
   AND metadata ? 'staff_only';

-- ─────────────────────────────────────────────────────────────── 2. formation summary type
INSERT INTO public.catalog_entries (catalog_id, slug, display_name, description, status, metadata)
VALUES ('storage_document_types', 'formation_summary', 'Formation Summary',
        'The formation wizard answers as a PDF (staff-only: holds every member''s personal data).', 'active',
        '{"personal": false, "staff_only": true, "legacy_category": 1, "proof_of_filing": false, "suggested_folder": "1. Company",
          "default_published": false, "freeze_when_filed": false, "default_folder_kind": "company", "draft_never_visible": false}'::jsonb)
ON CONFLICT (catalog_id, slug) DO UPDATE SET metadata = EXCLUDED.metadata, display_name = EXCLUDED.display_name, updated_at = now();

-- ─────────────────────────────────────────────────────────────── 3. cancel / reactivate
CREATE OR REPLACE FUNCTION public.store_formation_status_follow()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  BEGIN
    IF NEW.status = 'cancelled' THEN
      UPDATE public.store_owners SET lifecycle_override = 'archived', updated_at = now()
       WHERE service_delivery_id = NEW.id AND kind = 'formation' AND lifecycle_override = 'in_formation'
      RETURNING id INTO v_owner;
      IF v_owner IS NOT NULL THEN
        INSERT INTO public.store_events (event, owner_id, reason, details)
        VALUES ('formation_archived', v_owner, 'Formation cancelled',
                jsonb_build_object('service_delivery_id', NEW.id, 'from_status', OLD.status));
      END IF;
    ELSIF OLD.status = 'cancelled' AND NEW.status = 'active' THEN
      UPDATE public.store_owners SET lifecycle_override = 'in_formation', updated_at = now()
       WHERE service_delivery_id = NEW.id AND kind = 'formation' AND lifecycle_override = 'archived'
      RETURNING id INTO v_owner;
      IF v_owner IS NOT NULL THEN
        INSERT INTO public.store_events (event, owner_id, reason, details)
        VALUES ('formation_reopened', v_owner, 'Formation reactivated',
                jsonb_build_object('service_delivery_id', NEW.id));
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- never block the CRM's own status change; leave a trace instead
    RAISE WARNING 'store: formation storage did not follow status % → % for %: %', OLD.status, NEW.status, NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_store_formation_status_follow ON public.service_deliveries;
CREATE TRIGGER trg_store_formation_status_follow
  AFTER UPDATE OF status ON public.service_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.store_formation_status_follow();

-- ─────────────────────────────────────────────────────────────── 3b. attach only to the LINKED company
-- The handover used to trust its caller to pass the company the formation case was linked to. The S6
-- proof showed a wrong pairing was accepted; the database now checks it (same body as slice 1 otherwise).
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
  IF NOT EXISTS (SELECT 1 FROM public.service_deliveries WHERE id = p_service_delivery_id AND account_id = p_account_id) THEN
    RAISE EXCEPTION 'store: formation % is not linked to company % — attach only after the company-creation step linked it', p_service_delivery_id, p_account_id
      USING ERRCODE = 'check_violation';
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

-- ─────────────────────────────────────────────────────────────── 4. root folder name
CREATE OR REPLACE FUNCTION public.store_rename_root(p_owner_id uuid, p_name text, p_actor uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_root record;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN RETURN false; END IF;
  SELECT id, name INTO v_root FROM public.store_folders
   WHERE owner_id = p_owner_id AND parent_id IS NULL AND trashed_at IS NULL FOR UPDATE;
  IF v_root.id IS NULL OR v_root.name = btrim(p_name) THEN RETURN false; END IF;
  UPDATE public.store_folders SET name = btrim(p_name), updated_at = now() WHERE id = v_root.id;
  INSERT INTO public.store_events (event, actor, owner_id, folder_id, name_snapshot, details)
  VALUES ('folder_renamed', p_actor, p_owner_id, v_root.id, btrim(p_name), jsonb_build_object('from', v_root.name));
  RETURN true;
END $$;

-- ─────────────────────────────────────────────────────────────── 5. one CRM row per store file
-- The CRM `documents` list points at a store file as drive_file_id = 'store:<file id>'. Two wizard-submit
-- runs at the same moment both saw "not listed yet" and both inserted (found by the S6 route E2E). One row
-- per store file is now a database rule — only for store pointers (Drive ids and `storage:` pointers are
-- untouched). Production has no store rows, so the clean-up below is a no-op there.
DELETE FROM public.documents d
 USING public.documents keep
 WHERE d.drive_file_id LIKE 'store:%' AND keep.drive_file_id = d.drive_file_id
   AND (keep.created_at, keep.id) < (d.created_at, d.id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_store_pointer
  ON public.documents (drive_file_id) WHERE drive_file_id LIKE 'store:%';

REVOKE ALL ON FUNCTION public.store_type_staff_only(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_formation_status_follow() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_rename_root(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_attach_formation(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;

COMMIT;
