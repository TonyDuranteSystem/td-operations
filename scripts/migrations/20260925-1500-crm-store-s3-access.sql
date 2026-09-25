-- CRM Store — slice S3: access, visibility and sending (master plan v4.5 §8.2, §8.4, §8.9 #3; job 685467b5)
-- SANDBOX FIRST. Dark: nothing calls these yet. Antonio 2026-09-25: "build dark, wire later" —
-- today's staff screens (Remove member / Unlink / Revoke access) and today's portal rule are NOT
-- changed here; they move onto these steps when the portal switches to the new store (Stage 1).
--
-- Principles (after the 2026-09-25 council):
--   · What a client sees depends ONLY on what is stored on the file (published + the draft rule +
--     amendments). No live override: staff "unpublish" always hides, "publish" always shows (a draft of
--     a "draft never visible" type is refused, not silently ignored). Stage defaults are applied ONCE,
--     when the file is created (store_write).
--   · Signing never exposes the unsigned draft: as today, the signed copy is its own file (published),
--     the prepared draft stays hidden (lib/flows/flow-doc-visibility.ts: "never the raw prepared draft").
--   · Personal = a personal document type, a person-owned file, OR a file with no known type (fail closed).
--   · Leaving and revoking are separate facts on the company–person link: ended_at + access_until (the
--     leaver's one-week window) and access_revoked_at (revoke). Reopening a membership never undoes a revoke.
--   · Until Stage 1 these facts are honoured by the NEW STORE ONLY — today's portal, chat, invoices and tier
--     keep reading the link as they do now. Stage 1 must move every reader onto them.
-- REQUIRES the member-ownership-periods migration (job f4c5c023: members.start_date / end_date) FIRST.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'members' AND column_name = 'end_date') THEN
    RAISE EXCEPTION 'CRM store S3 needs members.end_date (member-ownership-periods, job f4c5c023) — apply that first';
  END IF;
END $$;

-- functions whose shape changed since the first sandbox apply
DROP FUNCTION IF EXISTS public.store_record_send(uuid, text, jsonb, text, uuid, text);
DROP FUNCTION IF EXISTS public.store_revoke_portal_access(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.store_restore_portal_access(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.store_file_client_visible(uuid);

-- ─────────────────────────────────────────────────────────────── schema
-- revoke is its own fact (never overwritten by a leaver's window, never undone by a reopen)
ALTER TABLE public.account_contacts ADD COLUMN IF NOT EXISTS access_revoked_at timestamptz;
ALTER TABLE public.account_contacts ADD COLUMN IF NOT EXISTS access_revoked_by uuid;

-- "replaced by an amendment" is worked out from the chain, never stored (a stored flag would drift)
ALTER TABLE public.store_files DROP COLUMN IF EXISTS is_superseded;
CREATE INDEX IF NOT EXISTS store_files_supersedes_idx ON public.store_files (supersedes_file_id) WHERE supersedes_file_id IS NOT NULL;

-- an amendment's link to the file it replaces is set once, at creation (no later edit can make a loop)
CREATE OR REPLACE FUNCTION public.store_files_supersede_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.supersedes_file_id IS DISTINCT FROM OLD.supersedes_file_id THEN
    RAISE EXCEPTION 'store: which file an amendment replaces is fixed when it is created' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_store_files_supersede_guard ON public.store_files;
CREATE TRIGGER trg_store_files_supersede_guard BEFORE UPDATE ON public.store_files
  FOR EACH ROW EXECUTE FUNCTION public.store_files_supersede_guard();

-- queued (never auto-sent) exit invitations — the Stage-1 sender reads store_pending_exit_invitations()
CREATE TABLE IF NOT EXISTS public.store_exit_invitations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  contact_id    uuid NOT NULL REFERENCES public.contacts(id) ON DELETE RESTRICT,
  access_until  timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','cancelled')),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  cancelled_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS store_exit_invitations_one_queued_uq
  ON public.store_exit_invitations (account_id, contact_id) WHERE status = 'queued';
ALTER TABLE public.store_exit_invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_exit_invitations FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────── catalog: how each recipient class is checked
-- match_rule (data): own_person | company_members | representative | internal | external
UPDATE public.catalog_entries SET metadata = metadata || jsonb_build_object('match_rule', v.rule)
  FROM (VALUES ('own_person','own_person'), ('company_members','company_members'), ('representative','representative'),
               ('tax_authority','external'), ('accountant','external'), ('india_team','external'),
               ('bank','external'), ('other','external')) AS v(slug, rule)
 WHERE catalog_id = 'storage_recipient_classes' AND catalog_entries.slug = v.slug
   AND catalog_entries.metadata->>'match_rule' IS DISTINCT FROM v.rule;
INSERT INTO public.catalog_entries (catalog_id, slug, display_name, status, metadata)
SELECT v.catalog_id, v.slug, v.display_name, 'active', v.metadata::jsonb FROM (VALUES
  ('storage_recipient_classes','staff_internal',  'TD staff (internal team chat / colleague)',
     '{"personal_files_allowed":true,"needs_reason":false,"match_rule":"internal"}'),
  ('storage_recipient_classes','service_provider','A service provider (CMRA / mail, registered agent, notary)',
     '{"personal_files_allowed":true,"needs_reason":true,"match_rule":"external"}')
) AS v(catalog_id, slug, display_name, metadata)
WHERE NOT EXISTS (SELECT 1 FROM public.catalog_entries c WHERE c.catalog_id = v.catalog_id AND c.slug = v.slug);

-- ─────────────────────────────────────────────────────────────── company access for one person
-- A link grants access when its normalised role is a portal-audience role (owner / member /
-- representative — NOT consultant/collaborator, Antonio #44). A role-less link counts as the owner only
-- when it is the company's only live link that could be an owner (role-less or audience-role) — so a
-- consultant link beside a single-member owner does not lock the owner out, and a stray role-less link
-- on a multi-member company is not promoted while other members are live.
CREATE OR REPLACE FUNCTION public.store_link_role_slug(p_account_id uuid, p_contact_id uuid)
RETURNS text LANGUAGE sql STABLE AS $$
  WITH me AS (
    SELECT ac.*, public.store_role_key(ac.role) AS rk FROM public.account_contacts ac
     WHERE ac.account_id = p_account_id AND ac.contact_id = p_contact_id
  ), candidates AS (
    SELECT count(*) AS n FROM public.account_contacts x
     WHERE x.account_id = p_account_id AND (x.ended_at IS NULL OR x.contact_id = p_contact_id)
       AND ( public.store_role_key(x.role) = ''
          OR EXISTS (SELECT 1 FROM public.catalog_entries r
                      WHERE r.catalog_id = 'storage_contact_roles' AND r.status = 'active'
                        AND coalesce((r.metadata->>'portal_audience')::boolean, false)
                        AND r.metadata->'matches' ? public.store_role_key(x.role)) )
  )
  SELECT coalesce(
           (SELECT r.slug FROM public.catalog_entries r, me
             WHERE r.catalog_id = 'storage_contact_roles' AND r.status = 'active' AND r.metadata->'matches' ? me.rk
             ORDER BY r.slug LIMIT 1),
           (SELECT 'owner' FROM me, candidates WHERE me.rk = '' AND candidates.n = 1))
$$;

CREATE OR REPLACE FUNCTION public.store_contact_company_access(p_account_id uuid, p_contact_id uuid)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN ac.access_revoked_at IS NOT NULL THEN NULL
           WHEN ac.ended_at IS NULL THEN 'current'
           WHEN ac.access_until > now() THEN 'leaving'
         END
    FROM public.account_contacts ac
    JOIN public.catalog_entries r
      ON r.catalog_id = 'storage_contact_roles' AND r.status = 'active'
     AND r.slug = public.store_link_role_slug(ac.account_id, ac.contact_id)
     AND coalesce((r.metadata->>'portal_audience')::boolean, false)
   WHERE ac.account_id = p_account_id AND ac.contact_id = p_contact_id
$$;

-- the Contacts view (S1) uses the same role rule
CREATE OR REPLACE FUNCTION public.store_company_contacts(p_account_id uuid)
RETURNS TABLE (contact_id uuid, role_slug text) LANGUAGE sql STABLE AS $$
  SELECT ac.contact_id, public.store_link_role_slug(ac.account_id, ac.contact_id)
    FROM public.account_contacts ac
    JOIN public.catalog_entries c
      ON c.catalog_id = 'storage_contact_roles' AND c.status = 'active'
     AND c.slug = public.store_link_role_slug(ac.account_id, ac.contact_id)
     AND coalesce((c.metadata->>'appears_in_contacts')::boolean, false)
   WHERE ac.account_id = p_account_id AND ac.ended_at IS NULL
$$;

-- CRM status → portal visibility, from the lifecycle map (data). Unknown status = hidden.
CREATE OR REPLACE FUNCTION public.store_company_portal_visible(p_account_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT (m.metadata->>'portal_visible')::boolean
      FROM public.accounts a
      JOIN public.catalog_entries m
        ON m.catalog_id = 'storage_lifecycle_map' AND m.status = 'active'
       AND m.metadata->>'account_status' = a.status::text
     WHERE a.id = p_account_id
     LIMIT 1), false)
$$;

-- ─────────────────────────────────────────────────────────────── is the file shown to clients at all?
-- On its own: live, published, and not a draft of a "draft never visible" type.
CREATE OR REPLACE FUNCTION public.store_file_self_visible(p_file_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT f.state = 'live' AND f.published
           AND NOT (f.filing_status = 'draft' AND coalesce((
                 SELECT (t.metadata->>'draft_never_visible')::boolean FROM public.catalog_entries t
                  WHERE t.catalog_id = 'storage_document_types' AND t.slug = f.document_type), false))
      FROM public.store_files f WHERE f.id = p_file_id), false)
$$;

-- Shown = visible on its own AND not replaced by any visible amendment further down its chain
-- (A ← B ← C: C visible hides A and B). Cycle-safe and depth-limited.
CREATE OR REPLACE FUNCTION public.store_file_client_visible(p_file_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE chain(id, depth, path) AS (
    SELECT n.id, 1, ARRAY[p_file_id, n.id] FROM public.store_files n
     WHERE n.supersedes_file_id = p_file_id AND n.state = 'live'
    UNION ALL
    SELECT n.id, c.depth + 1, c.path || n.id FROM public.store_files n JOIN chain c ON n.supersedes_file_id = c.id
     WHERE n.state = 'live' AND c.depth < 20 AND NOT n.id = ANY (c.path)
  )
  SELECT public.store_file_self_visible(p_file_id)
     AND NOT EXISTS (SELECT 1 FROM chain WHERE public.store_file_self_visible(chain.id))
$$;

-- personal: person-owned, a personal type, or NO known type (fail closed)
CREATE OR REPLACE FUNCTION public.store_file_is_personal(p_file_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT o.kind = 'person' OR coalesce((
           SELECT (t.metadata->>'personal')::boolean FROM public.catalog_entries t
            WHERE t.catalog_id = 'storage_document_types' AND t.slug = f.document_type AND t.status = 'active'), true)
    FROM public.store_files f JOIN public.store_owners o ON o.id = f.owner_id
   WHERE f.id = p_file_id
$$;

-- ─────────────────────────────────────────────────────────────── may THIS viewer see THIS file?
-- 'ok' / 'ok_leaving' or a refusal code (fail closed). Personal files: only the person they belong to —
-- the person owner, or a person subject who still has access to the company — never teammates.
CREATE OR REPLACE FUNCTION public.store_file_access(p_file_id uuid, p_contact_id uuid, p_teammate_id uuid)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  f record;
  o record;
  v_personal boolean;
  v_access text;
  v_buyer uuid;
  t record;
BEGIN
  IF (p_contact_id IS NULL) = (p_teammate_id IS NULL) THEN RETURN 'viewer_required'; END IF;
  SELECT id, owner_id, state INTO f FROM public.store_files WHERE id = p_file_id;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF f.state <> 'live' THEN RETURN 'not_live'; END IF;
  SELECT * INTO o FROM public.store_owners WHERE id = f.owner_id;
  IF o.kind = 'unfiled' THEN RETURN 'unfiled'; END IF;
  IF NOT public.store_file_client_visible(f.id) THEN RETURN 'not_client_visible'; END IF;

  v_personal := public.store_file_is_personal(f.id);
  IF v_personal AND p_teammate_id IS NOT NULL THEN RETURN 'personal_not_for_teammates'; END IF;

  IF o.kind = 'person' THEN
    RETURN CASE WHEN o.contact_id = p_contact_id THEN 'ok' ELSE 'not_the_person' END;
  END IF;

  IF o.kind = 'formation' THEN
    IF p_teammate_id IS NOT NULL THEN RETURN 'no_access'; END IF;
    IF o.lifecycle_override IS DISTINCT FROM 'in_formation' THEN RETURN 'company_hidden'; END IF;
    SELECT contact_id INTO v_buyer FROM public.service_deliveries WHERE id = o.service_delivery_id;
    IF v_buyer IS DISTINCT FROM p_contact_id THEN RETURN 'not_the_buyer'; END IF;
    IF v_personal AND NOT EXISTS (SELECT 1 FROM public.store_file_subjects s
                                   WHERE s.file_id = f.id AND s.subject_kind = 'person' AND s.contact_id = p_contact_id) THEN
      RETURN 'not_the_person';
    END IF;
    RETURN 'ok';
  END IF;

  -- company
  IF NOT public.store_company_portal_visible(o.account_id) THEN RETURN 'company_hidden'; END IF;
  IF p_teammate_id IS NOT NULL THEN
    SELECT account_id, status, capabilities INTO t FROM public.portal_team_members WHERE id = p_teammate_id;
    IF NOT FOUND OR t.status <> 'active' OR t.account_id IS DISTINCT FROM o.account_id THEN RETURN 'no_access'; END IF;
    IF (t.capabilities->'documents') IS DISTINCT FROM 'true'::jsonb THEN RETURN 'teammate_no_documents'; END IF;
    RETURN 'ok';
  END IF;
  v_access := public.store_contact_company_access(o.account_id, p_contact_id);
  IF v_access IS NULL THEN RETURN 'no_company_access'; END IF;
  IF v_personal AND NOT EXISTS (SELECT 1 FROM public.store_file_subjects s
                                 WHERE s.file_id = f.id AND s.subject_kind = 'person' AND s.contact_id = p_contact_id) THEN
    RETURN 'not_the_person';
  END IF;
  RETURN CASE WHEN v_access = 'leaving' THEN 'ok_leaving' ELSE 'ok' END;
END $$;

-- Every file one viewer may see (optionally within one owner) — the ONLY listing tree/search/zip may use.
CREATE OR REPLACE FUNCTION public.store_visible_files(p_contact_id uuid, p_teammate_id uuid, p_owner_id uuid DEFAULT NULL)
RETURNS TABLE (file_id uuid, owner_id uuid, folder_id uuid, name text, document_type text, period_year integer, access text)
LANGUAGE sql STABLE AS $$
  WITH owners AS (
    SELECT o.id FROM public.store_owners o
     WHERE p_contact_id IS NOT NULL AND p_teammate_id IS NULL AND (
            (o.kind = 'person' AND o.contact_id = p_contact_id)
         OR (o.kind = 'company' AND EXISTS (SELECT 1 FROM public.account_contacts ac
                                             WHERE ac.account_id = o.account_id AND ac.contact_id = p_contact_id))
         OR (o.kind = 'formation' AND EXISTS (SELECT 1 FROM public.service_deliveries sd
                                               WHERE sd.id = o.service_delivery_id AND sd.contact_id = p_contact_id)))
    UNION
    SELECT o.id FROM public.store_owners o JOIN public.portal_team_members tm ON tm.account_id = o.account_id
     WHERE p_teammate_id IS NOT NULL AND p_contact_id IS NULL AND tm.id = p_teammate_id AND o.kind = 'company'
  )
  SELECT f.id, f.owner_id, f.folder_id, f.name, f.document_type, f.period_year, a.code
    FROM public.store_files f
    JOIN owners ow ON ow.id = f.owner_id
    CROSS JOIN LATERAL (SELECT public.store_file_access(f.id, p_contact_id, p_teammate_id) AS code) a
   WHERE f.state = 'live' AND f.published AND (p_owner_id IS NULL OR f.owner_id = p_owner_id)
     AND a.code IN ('ok','ok_leaving')
$$;

-- ─────────────────────────────────────────────────────────────── sending (staff action)
-- p_recipient: {contact_id?, email?}. How each class is checked is catalog data (match_rule,
-- personal_files_allowed, needs_reason). Returns 'ok' or a refusal code.
CREATE OR REPLACE FUNCTION public.store_send_check(p_file_id uuid, p_recipient_class text, p_recipient jsonb, p_reason text)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  f record;
  o record;
  c record;
  v_personal boolean;
  v_contact uuid := nullif(coalesce(p_recipient->>'contact_id',''),'')::uuid;
  v_email text := lower(btrim(coalesce(p_recipient->>'email','')));
  v_person_ok boolean;
BEGIN
  SELECT slug, metadata->>'match_rule' AS rule,
         coalesce((metadata->>'personal_files_allowed')::boolean,false) AS personal_ok,
         coalesce((metadata->>'needs_reason')::boolean,true) AS needs_reason
    INTO c FROM public.catalog_entries
   WHERE catalog_id = 'storage_recipient_classes' AND slug = p_recipient_class AND status = 'active';
  IF NOT FOUND OR c.rule IS NULL THEN RETURN 'unknown_recipient_class'; END IF;
  SELECT id, owner_id, state INTO f FROM public.store_files WHERE id = p_file_id;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF f.state <> 'live' THEN RETURN 'not_live'; END IF;
  SELECT * INTO o FROM public.store_owners WHERE id = f.owner_id;
  IF o.kind = 'unfiled' THEN RETURN 'unfiled_must_be_classified'; END IF;
  IF c.needs_reason AND length(btrim(coalesce(p_reason,''))) = 0 THEN RETURN 'reason_required'; END IF;

  v_personal := public.store_file_is_personal(f.id);
  v_person_ok := v_contact IS NOT NULL AND (
       (o.kind = 'person' AND o.contact_id = v_contact)
    OR EXISTS (SELECT 1 FROM public.store_file_subjects s
                WHERE s.file_id = f.id AND s.subject_kind = 'person' AND s.contact_id = v_contact));

  IF c.rule = 'own_person' THEN
    IF v_contact IS NULL THEN RETURN 'recipient_required'; END IF;
    IF v_personal THEN RETURN CASE WHEN v_person_ok THEN 'ok' ELSE 'not_the_person' END; END IF;
    IF o.kind = 'company' AND public.store_contact_company_access(o.account_id, v_contact) IS NOT NULL THEN RETURN 'ok'; END IF;
    IF o.kind = 'formation' AND EXISTS (SELECT 1 FROM public.service_deliveries sd
                                         WHERE sd.id = o.service_delivery_id AND sd.contact_id = v_contact) THEN RETURN 'ok'; END IF;
    RETURN 'not_in_company';
  END IF;

  IF v_personal AND NOT c.personal_ok THEN RETURN 'personal_not_allowed'; END IF;

  IF c.rule = 'company_members' THEN
    IF v_contact IS NULL THEN RETURN 'recipient_required'; END IF;
    IF o.kind = 'company' AND public.store_contact_company_access(o.account_id, v_contact) = 'current' THEN RETURN 'ok'; END IF;
    IF o.kind = 'formation' AND EXISTS (SELECT 1 FROM public.service_deliveries sd
                                         WHERE sd.id = o.service_delivery_id AND sd.contact_id = v_contact) THEN RETURN 'ok'; END IF;
    RETURN 'not_in_company';
  END IF;

  IF c.rule = 'representative' THEN
    IF o.kind <> 'company' THEN RETURN 'not_a_representative'; END IF;
    -- a representative who is a CRM contact: a CURRENT representative link (not ended, not revoked)
    IF v_contact IS NOT NULL
       AND public.store_link_role_slug(o.account_id, v_contact) = 'representative'
       AND public.store_contact_company_access(o.account_id, v_contact) = 'current' THEN RETURN 'ok'; END IF;
    -- a member's representative on the members list (free text): only while that member is current
    IF v_email <> '' AND EXISTS (
         SELECT 1 FROM public.members m
          WHERE m.account_id = o.account_id AND lower(btrim(m.representative_email)) = v_email
            AND m.end_date IS NULL
            AND (m.contact_id IS NULL OR public.store_contact_company_access(o.account_id, m.contact_id) = 'current')) THEN
      RETURN 'ok';
    END IF;
    RETURN 'not_a_representative';
  END IF;

  IF c.rule IN ('internal','external') THEN RETURN 'ok'; END IF;
  RETURN 'unknown_recipient_class';
END $$;

-- Record a send AFTER it happened (send first, record after — R037). A send that the rules would refuse
-- is STILL recorded (as 'sent_outside_rules', with the refusal code) — the audit never loses a real send.
CREATE OR REPLACE FUNCTION public.store_record_send(p_file_id uuid, p_recipient_class text, p_recipient jsonb,
                                                    p_reason text, p_actor uuid, p_channel text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_code text := public.store_send_check(p_file_id, p_recipient_class, p_recipient, p_reason);
  f record;
  v_id bigint;
BEGIN
  SELECT id, owner_id, folder_id, name, current_version_id INTO f FROM public.store_files WHERE id = p_file_id;
  INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot, recipient_class, reason, details)
  VALUES (CASE WHEN v_code = 'ok' THEN 'sent' ELSE 'sent_outside_rules' END, p_actor, f.owner_id, p_file_id, f.folder_id, f.name,
          p_recipient_class, nullif(btrim(coalesce(p_reason,'')),''),
          jsonb_build_object('channel', p_channel, 'recipient', coalesce(p_recipient,'{}'::jsonb),
                             'version_id', f.current_version_id, 'check', v_code))
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('event_id', v_id, 'code', v_code);
END $$;

-- Portal views of PERSONAL files are recorded — allowed ones as 'viewed', refused attempts as 'view_refused'.
CREATE OR REPLACE FUNCTION public.store_record_view(p_file_id uuid, p_contact_id uuid, p_teammate_id uuid)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_code text := public.store_file_access(p_file_id, p_contact_id, p_teammate_id);
  f record;
BEGIN
  SELECT id, owner_id, folder_id, name INTO f FROM public.store_files WHERE id = p_file_id;
  IF FOUND AND public.store_file_is_personal(p_file_id) AND v_code NOT IN ('viewer_required','not_found') THEN
    INSERT INTO public.store_events (event, owner_id, file_id, folder_id, name_snapshot, details)
    VALUES (CASE WHEN v_code IN ('ok','ok_leaving') THEN 'viewed' ELSE 'view_refused' END, f.owner_id, f.id, f.folder_id, f.name,
            jsonb_build_object('contact_id', p_contact_id, 'teammate_id', p_teammate_id, 'access', v_code));
  END IF;
  RETURN v_code;
END $$;

-- ─────────────────────────────────────────────────────────────── staff: publish / filing status
-- The per-file "visible to client" switch. It always does what it says: unpublish hides, publish shows —
-- except a draft of a "draft never visible" type, which is refused (save the signed copy / mark it filed).
CREATE OR REPLACE FUNCTION public.store_set_published(p_file_id uuid, p_published boolean, p_actor uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  f record;
BEGIN
  SELECT id, owner_id, folder_id, name, state, published, filing_status, document_type INTO f
    FROM public.store_files WHERE id = p_file_id FOR UPDATE;
  IF NOT FOUND OR f.state <> 'live' THEN RAISE EXCEPTION 'store: only a live file can be published or unpublished'; END IF;
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

-- Staff: move a file's filing status forward (none → draft → filed; an amendment → amended). Never back.
CREATE OR REPLACE FUNCTION public.store_set_filing_status(p_file_id uuid, p_status text, p_actor uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  f record;
  v_old int;
  v_new int;
BEGIN
  SELECT id, owner_id, folder_id, name, state, filing_status, supersedes_file_id INTO f
    FROM public.store_files WHERE id = p_file_id FOR UPDATE;
  IF NOT FOUND OR f.state <> 'live' THEN RAISE EXCEPTION 'store: only a live file can change filing status'; END IF;
  IF p_status NOT IN ('draft','filed','amended') THEN RAISE EXCEPTION 'store: unknown filing status %', p_status; END IF;
  IF p_status = 'amended' AND f.supersedes_file_id IS NULL THEN
    RAISE EXCEPTION 'store: only a file that replaces another one can be marked amended';
  END IF;
  v_old := CASE f.filing_status WHEN 'none' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END;
  v_new := CASE p_status WHEN 'draft' THEN 1 ELSE 2 END;
  IF f.filing_status = p_status THEN RETURN false; END IF;
  IF v_new <= v_old THEN RAISE EXCEPTION 'store: filing status only moves forward (% → % refused)', f.filing_status, p_status; END IF;
  UPDATE public.store_files SET filing_status = p_status WHERE id = p_file_id;
  INSERT INTO public.store_events (event, actor, owner_id, file_id, folder_id, name_snapshot, details)
  VALUES (CASE WHEN p_status = 'draft' THEN 'status_changed' ELSE p_status END, p_actor, f.owner_id, f.id, f.folder_id, f.name,
          jsonb_build_object('from', f.filing_status, 'to', p_status));
  RETURN true;
END $$;

-- ─────────────────────────────────────────────────────────────── a member leaves (#40) / access revoked
-- End membership: the company–person link and the members-list row end softly (left-on date, in TD's
-- time zone); a person who HAD company access keeps it for the window (default 7 days) and a download
-- invitation is QUEUED (sending it is Stage 1's job — nothing is emailed from here).
CREATE OR REPLACE FUNCTION public.store_end_membership(p_account_id uuid, p_contact_id uuid, p_actor uuid,
                                                       p_reason text DEFAULT NULL, p_window interval DEFAULT interval '7 days')
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  l record;
  v_had text;
  v_until timestamptz := now() + p_window;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_members int;
  v_inv uuid;
  v_owner uuid;
BEGIN
  SELECT * INTO l FROM public.account_contacts WHERE account_id = p_account_id AND contact_id = p_contact_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'store: this person is not linked to this company'; END IF;
  IF l.ended_at IS NOT NULL THEN
    RETURN jsonb_build_object('status','already_ended','ended_at',l.ended_at,'access_until',l.access_until);
  END IF;
  v_had := public.store_contact_company_access(p_account_id, p_contact_id);
  UPDATE public.account_contacts SET ended_at = now(), ended_by = p_actor, access_until = v_until
   WHERE account_id = p_account_id AND contact_id = p_contact_id;
  UPDATE public.members SET end_date = v_today
   WHERE account_id = p_account_id AND contact_id = p_contact_id AND end_date IS NULL;
  GET DIAGNOSTICS v_members = ROW_COUNT;
  IF v_had = 'current' THEN
    INSERT INTO public.store_exit_invitations (account_id, contact_id, access_until, created_by)
    VALUES (p_account_id, p_contact_id, v_until, p_actor)
    ON CONFLICT (account_id, contact_id) WHERE status = 'queued' DO UPDATE SET access_until = EXCLUDED.access_until
    RETURNING id INTO v_inv;
  END IF;
  SELECT id INTO v_owner FROM public.store_owners WHERE account_id = p_account_id;
  INSERT INTO public.store_events (event, actor, owner_id, reason, details)
  VALUES ('membership_ended', p_actor, v_owner, p_reason,
          jsonb_build_object('account_id', p_account_id, 'contact_id', p_contact_id, 'access_until', v_until,
                             'invitation_id', v_inv, 'had_access', v_had,
                             'members_end_date', CASE WHEN v_members > 0 THEN v_today END));
  RETURN jsonb_build_object('status','ended','access_until',v_until,'invitation_id',v_inv);
END $$;

-- Undo a mistaken end: the link is live again; ONLY the members-list end date this end wrote is cleared
-- (earlier ownership periods are kept); a revoke stays revoked; the queued invitation is cancelled.
CREATE OR REPLACE FUNCTION public.store_reopen_membership(p_account_id uuid, p_contact_id uuid, p_actor uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  l record;
  v_owner uuid;
  v_date date;
BEGIN
  SELECT * INTO l FROM public.account_contacts WHERE account_id = p_account_id AND contact_id = p_contact_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'store: this person is not linked to this company'; END IF;
  IF l.ended_at IS NULL THEN RETURN jsonb_build_object('status','not_ended'); END IF;
  SELECT (details->>'members_end_date')::date INTO v_date FROM public.store_events
   WHERE event = 'membership_ended' AND details->>'account_id' = p_account_id::text AND details->>'contact_id' = p_contact_id::text
   ORDER BY occurred_at DESC, id DESC LIMIT 1;
  UPDATE public.account_contacts SET ended_at = NULL, ended_by = NULL, access_until = NULL
   WHERE account_id = p_account_id AND contact_id = p_contact_id;
  IF v_date IS NOT NULL THEN
    UPDATE public.members SET end_date = NULL
     WHERE account_id = p_account_id AND contact_id = p_contact_id AND end_date = v_date;
  END IF;
  UPDATE public.store_exit_invitations SET status = 'cancelled', cancelled_at = now()
   WHERE account_id = p_account_id AND contact_id = p_contact_id AND status = 'queued';
  SELECT id INTO v_owner FROM public.store_owners WHERE account_id = p_account_id;
  INSERT INTO public.store_events (event, actor, owner_id, reason, details)
  VALUES ('membership_reopened', p_actor, v_owner, p_reason,
          jsonb_build_object('account_id', p_account_id, 'contact_id', p_contact_id, 'members_end_date_cleared', v_date));
  RETURN jsonb_build_object('status','reopened','still_revoked', l.access_revoked_at IS NOT NULL);
END $$;

-- Revoke access to the company's stored documents at once; membership unchanged; no invitation (a queued
-- leaver's invitation is cancelled). Until Stage 1 this governs the NEW STORE ONLY.
CREATE OR REPLACE FUNCTION public.store_revoke_access(p_account_id uuid, p_contact_id uuid, p_actor uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  l record;
  v_owner uuid;
BEGIN
  SELECT * INTO l FROM public.account_contacts WHERE account_id = p_account_id AND contact_id = p_contact_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'store: this person is not linked to this company'; END IF;
  IF l.access_revoked_at IS NOT NULL THEN RETURN jsonb_build_object('status','already_revoked'); END IF;
  UPDATE public.account_contacts SET access_revoked_at = now(), access_revoked_by = p_actor
   WHERE account_id = p_account_id AND contact_id = p_contact_id;
  UPDATE public.store_exit_invitations SET status = 'cancelled', cancelled_at = now()
   WHERE account_id = p_account_id AND contact_id = p_contact_id AND status = 'queued';
  SELECT id INTO v_owner FROM public.store_owners WHERE account_id = p_account_id;
  INSERT INTO public.store_events (event, actor, owner_id, reason, details)
  VALUES ('access_revoked', p_actor, v_owner, p_reason, jsonb_build_object('account_id', p_account_id, 'contact_id', p_contact_id));
  RETURN jsonb_build_object('status','revoked');
END $$;

-- Lift a revoke. A leaver whose window is over still has no access (restoring never extends a window).
CREATE OR REPLACE FUNCTION public.store_restore_access(p_account_id uuid, p_contact_id uuid, p_actor uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  l record;
  v_owner uuid;
BEGIN
  SELECT * INTO l FROM public.account_contacts WHERE account_id = p_account_id AND contact_id = p_contact_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'store: this person is not linked to this company'; END IF;
  IF l.access_revoked_at IS NULL THEN RETURN jsonb_build_object('status','not_revoked'); END IF;
  UPDATE public.account_contacts SET access_revoked_at = NULL, access_revoked_by = NULL
   WHERE account_id = p_account_id AND contact_id = p_contact_id;
  SELECT id INTO v_owner FROM public.store_owners WHERE account_id = p_account_id;
  INSERT INTO public.store_events (event, actor, owner_id, reason, details)
  VALUES ('access_restored', p_actor, v_owner, p_reason, jsonb_build_object('account_id', p_account_id, 'contact_id', p_contact_id));
  RETURN jsonb_build_object('status','restored','access', public.store_contact_company_access(p_account_id, p_contact_id));
END $$;

-- What the Stage-1 invitation sender may send: queued, window still open, not revoked (re-checked live).
CREATE OR REPLACE FUNCTION public.store_pending_exit_invitations(p_limit integer DEFAULT 100)
RETURNS TABLE (id uuid, account_id uuid, contact_id uuid, access_until timestamptz) LANGUAGE sql STABLE AS $$
  SELECT i.id, i.account_id, i.contact_id, i.access_until FROM public.store_exit_invitations i
   WHERE i.status = 'queued' AND i.access_until > now()
     AND public.store_contact_company_access(i.account_id, i.contact_id) = 'leaving'
   ORDER BY i.created_at LIMIT p_limit
$$;

REVOKE ALL ON FUNCTION public.store_files_supersede_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_link_role_slug(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_contact_company_access(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_company_contacts(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_company_portal_visible(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_file_self_visible(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_file_client_visible(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_file_is_personal(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_file_access(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_visible_files(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_send_check(uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_record_send(uuid, text, jsonb, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_record_view(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_set_published(uuid, boolean, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_set_filing_status(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_end_membership(uuid, uuid, uuid, text, interval) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_reopen_membership(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_revoke_access(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_restore_access(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_pending_exit_invitations(integer) FROM PUBLIC, anon, authenticated;

COMMIT;
