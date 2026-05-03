-- Migration: 20260503-2200-address-registry-prod-backfill
-- Purpose: Bring production schema in sync with sandbox for the address/SS-4
-- audit work (A1–D2 phases) that was committed to code in earlier sessions
-- but only applied to sandbox via direct pg. The phase1-audit-flags branch
-- merged to main today (commit 762978d3) carries code that references these
-- tables/columns — the production /clients/audit page errors with
-- "column accounts.business_legal_address_id does not exist" until this lands.
--
-- Schema captured fresh from sandbox 2026-05-03 via information_schema +
-- pg_indexes + pg_policy + pg_class. All DDL is purely additive — new
-- tables get zero rows, new columns get NULL or default-false, no row
-- backfill needed. Legacy rows are correctly in the "no address linked"
-- state until staff populates them via the per-client audit pass.

-- ─── addresses table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.addresses (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text        NOT NULL,
  name            text        NOT NULL,
  provider        text,
  agent_name      text,
  address_line1   text        NOT NULL,
  address_line2   text,
  city            text        NOT NULL,
  state           text        NOT NULL,
  zip             text        NOT NULL,
  country         text        NOT NULL DEFAULT 'US',
  county          text,
  is_td_provided  boolean     NOT NULL DEFAULT false,
  notes           text,
  active          boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text
);

CREATE INDEX IF NOT EXISTS addresses_kind_active_name_idx
  ON public.addresses (kind, active, name);
CREATE INDEX IF NOT EXISTS addresses_kind_active_td_name_idx
  ON public.addresses (kind, active, is_td_provided DESC, name);

ALTER TABLE public.addresses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all ON public.addresses;
CREATE POLICY service_role_all ON public.addresses
  FOR ALL
  USING (auth.role() = 'service_role'::text);

DROP POLICY IF EXISTS staff_select ON public.addresses;
CREATE POLICY staff_select ON public.addresses
  FOR SELECT
  USING (
    (auth.role() = 'authenticated'::text)
    AND (((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) <> 'client'::text)
  );

-- ─── audit_flags table ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_flags (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  text        NOT NULL,
  entity_id    uuid        NOT NULL,
  field_name   text        NOT NULL,
  flag_type    text        NOT NULL,
  note         text,
  marked_by    text        NOT NULL,
  marked_at    timestamptz NOT NULL DEFAULT now(),
  reversed_by  text,
  reversed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS audit_flags_entity_idx
  ON public.audit_flags (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_flags_reversed_idx
  ON public.audit_flags (entity_type, entity_id)
  WHERE (reversed_at IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS audit_flags_unique_active_flag
  ON public.audit_flags (entity_type, entity_id, field_name, flag_type);

ALTER TABLE public.audit_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all ON public.audit_flags;
CREATE POLICY service_role_all ON public.audit_flags
  FOR ALL
  USING (auth.role() = 'service_role'::text);

DROP POLICY IF EXISTS staff_select ON public.audit_flags;
CREATE POLICY staff_select ON public.audit_flags
  FOR SELECT
  USING (
    (auth.role() = 'authenticated'::text)
    AND (((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) <> 'client'::text)
  );

-- ─── accounts columns + FKs ─────────────────────────────────────────
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS business_legal_address_id    uuid,
  ADD COLUMN IF NOT EXISTS business_mailing_address_id  uuid,
  ADD COLUMN IF NOT EXISTS registered_agent_id          uuid,
  ADD COLUMN IF NOT EXISTS legal_link_verified          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mailing_link_verified        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ra_link_verified             boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'accounts_business_legal_address_id_fkey' AND table_name = 'accounts'
  ) THEN
    ALTER TABLE public.accounts
      ADD CONSTRAINT accounts_business_legal_address_id_fkey
      FOREIGN KEY (business_legal_address_id) REFERENCES public.addresses(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'accounts_business_mailing_address_id_fkey' AND table_name = 'accounts'
  ) THEN
    ALTER TABLE public.accounts
      ADD CONSTRAINT accounts_business_mailing_address_id_fkey
      FOREIGN KEY (business_mailing_address_id) REFERENCES public.addresses(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'accounts_registered_agent_id_fkey' AND table_name = 'accounts'
  ) THEN
    ALTER TABLE public.accounts
      ADD CONSTRAINT accounts_registered_agent_id_fkey
      FOREIGN KEY (registered_agent_id) REFERENCES public.addresses(id) ON DELETE SET NULL;
  END IF;
END$$;
