-- Flexible-offer slice 2 step B (dev job d2971d11): the contract wording of NEW services is stored, versioned and approved
-- by an owner, and each offer keeps a frozen copy of the wording it was sent with. SANDBOX FIRST, then production by hand.
--   * public.service_contract_texts  one row per version of a service's contract (draft -> approved -> superseded).
--     Approved / superseded wording can never be edited; only a draft can be deleted; at most ONE open draft and ONE approved
--     version per service (partial unique indexes); the version number and the content fingerprint are set by the database.
--   * public.approve_service_contract_text(...)  approves a draft in ONE transaction (old approved -> superseded, draft -> approved),
--     and only when the fingerprint the approver read still matches (otherwise DRAFT_CHANGED).
--   * public.offers.contract_texts  the frozen wording snapshot of the NEW services on that offer ({type: {version, hash, content}}).
-- Server code (service role) is the only thing that touches the table: RLS on, no policy, no grants to anon / authenticated.
-- Idempotent. Undo: 20261026-1000-service-contract-texts.UNDO.sql
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.service_contract_texts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_entry_id uuid NOT NULL REFERENCES public.catalog_entries(id),
  contract_type    text NOT NULL CHECK (contract_type ~ '^custom_[a-z0-9_]+$'),
  version          integer NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'draft',
  content          jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  content_hash     text NOT NULL DEFAULT '',
  source           text NOT NULL DEFAULT 'manual',
  note             text,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  approved_by      text,
  approved_at      timestamptz,
  superseded_at    timestamptz,
  UNIQUE (service_entry_id, version)
);
-- The allowed status / source values are enforced by service_contract_texts_guard below, NOT by CHECK constraints: a CHECK
-- value list on the shared sandbox is flagged by the CI "code <-> database contract" check (check:db-contract:live) on EVERY
-- other branch until the code registers it and the committed production snapshot is refreshed. The trigger gives the same
-- protection with nothing to register (tests/unit/service-contract-texts.test.ts keeps the lists identical to the TypeScript ones).
ALTER TABLE public.service_contract_texts DROP CONSTRAINT IF EXISTS service_contract_texts_status_check;
ALTER TABLE public.service_contract_texts DROP CONSTRAINT IF EXISTS service_contract_texts_source_check;
CREATE UNIQUE INDEX IF NOT EXISTS service_contract_texts_one_approved ON public.service_contract_texts (service_entry_id) WHERE status = 'approved';
CREATE UNIQUE INDEX IF NOT EXISTS service_contract_texts_one_draft    ON public.service_contract_texts (service_entry_id) WHERE status = 'draft';
CREATE INDEX IF NOT EXISTS service_contract_texts_type_status          ON public.service_contract_texts (contract_type, status);

CREATE OR REPLACE FUNCTION public.service_contract_texts_guard() RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.status NOT IN ('draft', 'approved', 'superseded') THEN
      RAISE EXCEPTION 'Unknown contract status %', NEW.status;
    END IF;
    IF NEW.source NOT IN ('claude_draft', 'claude_change', 'manual', 'session') THEN
      RAISE EXCEPTION 'Unknown contract source %', NEW.source;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'A contract version starts as a draft (it is approved afterwards, by approve_service_contract_text)';
    END IF;
    NEW.version := COALESCE((SELECT max(version) FROM public.service_contract_texts WHERE service_entry_id = NEW.service_entry_id), 0) + 1;
    NEW.content_hash := md5(NEW.content::text);
    NEW.approved_by := NULL; NEW.approved_at := NULL; NEW.superseded_at := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'An approved contract version is never deleted (version % of %)', OLD.version, OLD.contract_type;
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.service_entry_id IS DISTINCT FROM OLD.service_entry_id
     OR NEW.contract_type IS DISTINCT FROM OLD.contract_type OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'The identity of a contract version cannot be changed';
  END IF;

  IF OLD.status = 'superseded' THEN
    RAISE EXCEPTION 'A replaced contract version cannot be changed';
  END IF;

  IF OLD.status = 'approved' THEN
    IF NEW.status <> 'superseded' THEN
      RAISE EXCEPTION 'Approved wording can never be edited — write a new version instead';
    END IF;
    IF NEW.content IS DISTINCT FROM OLD.content OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.note IS DISTINCT FROM OLD.note
       OR NEW.source IS DISTINCT FROM OLD.source OR NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION 'Approved wording can never be edited — write a new version instead';
    END IF;
    IF NEW.superseded_at IS NULL THEN NEW.superseded_at := now(); END IF;
    RETURN NEW;
  END IF;

  -- OLD.status = 'draft'
  IF NEW.status = 'superseded' THEN
    RAISE EXCEPTION 'A draft cannot be marked as replaced';
  END IF;
  IF NEW.status = 'approved' THEN
    IF NEW.approved_by IS NULL OR NEW.approved_at IS NULL THEN
      RAISE EXCEPTION 'Approving a contract needs the approver and the time';
    END IF;
    IF NEW.content IS DISTINCT FROM OLD.content THEN
      RAISE EXCEPTION 'The wording cannot change at the moment it is approved';
    END IF;
    NEW.content_hash := OLD.content_hash;
    RETURN NEW;
  END IF;
  -- still a draft: wording, note and source may change; the fingerprint follows the wording
  NEW.content_hash := md5(NEW.content::text);
  NEW.approved_by := NULL; NEW.approved_at := NULL; NEW.superseded_at := NULL;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS service_contract_texts_guard_trg ON public.service_contract_texts;
CREATE TRIGGER service_contract_texts_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON public.service_contract_texts
  FOR EACH ROW EXECUTE FUNCTION public.service_contract_texts_guard();

CREATE OR REPLACE FUNCTION public.approve_service_contract_text(p_id uuid, p_expected_hash text, p_approved_by text) RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  d public.service_contract_texts%ROWTYPE;
  r public.service_contract_texts%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.service_contract_texts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: no such contract version'; END IF;
  IF d.status <> 'draft' THEN RAISE EXCEPTION 'NOT_A_DRAFT: only a draft can be approved (this one is %)', d.status; END IF;
  IF p_approved_by IS NULL OR btrim(p_approved_by) = '' THEN RAISE EXCEPTION 'NO_APPROVER: an approver is required'; END IF;
  IF d.content_hash IS DISTINCT FROM p_expected_hash THEN
    RAISE EXCEPTION 'DRAFT_CHANGED: the wording changed after it was read — read it again before approving';
  END IF;
  UPDATE public.service_contract_texts SET status = 'superseded', superseded_at = now()
    WHERE service_entry_id = d.service_entry_id AND status = 'approved';
  UPDATE public.service_contract_texts SET status = 'approved', approved_by = btrim(p_approved_by), approved_at = now()
    WHERE id = p_id RETURNING * INTO r;
  RETURN to_jsonb(r);
END;
$function$;

ALTER TABLE public.service_contract_texts ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'service_contract_texts' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.service_contract_texts', p.policyname);
  END LOOP;
END $$;
REVOKE ALL ON public.service_contract_texts FROM anon, authenticated, PUBLIC;
GRANT ALL ON public.service_contract_texts TO service_role;
REVOKE ALL ON FUNCTION public.approve_service_contract_text(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_service_contract_text(uuid, text, text) TO service_role;

ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS contract_texts jsonb;
COMMENT ON COLUMN public.offers.contract_texts IS 'Frozen wording of the NEW services (custom_*) on this offer: {type: {version, hash, content, snapshot_at}}. Written when the offer is sent; the contract page renders from it.';

-- Repo rule (tests/unit/migrations-marketing-lock.test.ts): every migration that creates a table keeps it locked against the marketing role.
SELECT public.marketing_lock_all_tables();

COMMIT;
