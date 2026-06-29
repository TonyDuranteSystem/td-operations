-- E-Sign system — Phase 0 schema foundation (2026-06-26).
--
-- Internal DocuSign/Dropbox-Sign-class e-signature engine, multi-tenant from
-- day one (TD-first use; client product switched on later). NEW `esign_*`
-- table family — does NOT touch the live `signature_requests` / Form 8879 path.
-- Generalizes the proven oa_agreements + oa_signatures "parent envelope +
-- per-signer rows" pattern.
--
-- Isolation model (verified): the portal reads via the service role (RLS
-- bypassed) + an app-layer account-scope choke-point. RLS here is DEFENSE-IN-
-- DEPTH only: enabled with a staff-only policy TO authenticated, so anon is
-- denied by default (avoids the signature_requests anon-read leak class) and
-- client-JWT direct access is denied; the service role bypasses RLS so all
-- server/portal/MCP code keeps working.
--
-- Idempotent: CREATE ... IF NOT EXISTS + DROP POLICY IF EXISTS before CREATE.

-- ───────────────────────────── envelopes ─────────────────────────────
-- The document being signed (the parent). owner_account_id + origin make it
-- multi-tenant: staff-origin = TD-internal; client-origin = owned by a client.
CREATE TABLE IF NOT EXISTS public.esign_envelopes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  token text NOT NULL,
  access_code text NOT NULL DEFAULT replace((gen_random_uuid())::text, '-', ''),
  owner_account_id uuid,                 -- soft ref accounts(id); NULL = TD-internal
  origin text NOT NULL DEFAULT 'staff',
  created_by_contact_id uuid,            -- soft ref contacts(id) — portal author
  created_by text NOT NULL DEFAULT 'system',
  contact_id uuid,                       -- soft ref contacts(id) — primary notify contact
  service_delivery_id uuid,              -- soft ref service_deliveries(id) — TD flow link
  template_id uuid,                      -- soft ref esign_templates(id) — provenance
  document_name text NOT NULL,
  description text,
  pdf_storage_path text,                 -- source PDF in signature-requests bucket
  signed_pdf_path text,                  -- final flattened PDF (set at completion)
  signed_pdf_drive_id text,
  certificate_path text,                 -- completion certificate
  page_count integer,
  routing_order text NOT NULL DEFAULT 'sequential',
  status text NOT NULL DEFAULT 'draft',
  signed_count integer NOT NULL DEFAULT 0,
  total_signers integer NOT NULL DEFAULT 1,
  expires_at timestamp with time zone,
  completed_at timestamp with time zone,
  voided_at timestamp with time zone,
  void_reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT esign_envelopes_pkey PRIMARY KEY (id),
  CONSTRAINT esign_envelopes_token_key UNIQUE (token),
  CONSTRAINT esign_envelopes_origin_check CHECK (origin IN ('staff','client')),
  CONSTRAINT esign_envelopes_routing_check CHECK (routing_order IN ('parallel','sequential')),
  CONSTRAINT esign_envelopes_status_check CHECK (status IN
    ('draft','sent','in_progress','completed','declined','voided','expired'))
);

CREATE INDEX IF NOT EXISTS idx_esign_envelopes_owner ON public.esign_envelopes(owner_account_id);
CREATE INDEX IF NOT EXISTS idx_esign_envelopes_status ON public.esign_envelopes(status);
CREATE INDEX IF NOT EXISTS idx_esign_envelopes_sd ON public.esign_envelopes(service_delivery_id)
  WHERE service_delivery_id IS NOT NULL;

-- ───────────────────────────── signers ─────────────────────────────
-- Per-signer state (the child). Generalizes oa_signatures. Each signer has its
-- own access_code + token; third parties have no contact_id.
CREATE TABLE IF NOT EXISTS public.esign_signers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  envelope_id uuid NOT NULL,
  signer_index integer NOT NULL,
  signing_order integer,
  name text NOT NULL,
  email text,
  contact_id uuid,                       -- soft ref contacts(id); NULL for third parties
  role_label text,
  access_code text NOT NULL DEFAULT replace((gen_random_uuid())::text, '-', ''),
  token text NOT NULL DEFAULT replace((gen_random_uuid())::text, '-', ''),
  status text NOT NULL DEFAULT 'pending',
  consent_acknowledged boolean NOT NULL DEFAULT false,
  consent_text text,
  sent_at timestamp with time zone,
  viewed_at timestamp with time zone,
  signed_at timestamp with time zone,
  declined_at timestamp with time zone,
  decline_reason text,
  view_count integer NOT NULL DEFAULT 0,
  signed_by_name text,
  signature_image_path text,
  initials_image_path text,              -- separate asset: initials != signature
  last_ip inet,
  last_user_agent text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT esign_signers_pkey PRIMARY KEY (id),
  CONSTRAINT esign_signers_envelope_fkey FOREIGN KEY (envelope_id)
    REFERENCES public.esign_envelopes(id) ON DELETE CASCADE,
  CONSTRAINT esign_signers_envelope_index_key UNIQUE (envelope_id, signer_index),
  CONSTRAINT esign_signers_token_key UNIQUE (token),
  CONSTRAINT esign_signers_status_check CHECK (status IN
    ('pending','sent','viewed','signed','declined'))
);

CREATE INDEX IF NOT EXISTS idx_esign_signers_envelope ON public.esign_signers(envelope_id);
CREATE INDEX IF NOT EXISTS idx_esign_signers_access_code ON public.esign_signers(access_code);
CREATE INDEX IF NOT EXISTS idx_esign_signers_status ON public.esign_signers(envelope_id, status);

-- ───────────────────────────── fields ─────────────────────────────
-- Every placed field (drag-drop output). Position is NORMALIZED 0..1, top-left
-- origin, resolution-independent. Signature/initials images live on the signer;
-- date/text/checkbox values live in `value`.
CREATE TABLE IF NOT EXISTS public.esign_fields (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  envelope_id uuid NOT NULL,
  signer_id uuid,                        -- which signer fills it (NULL = label/prefill)
  field_type text NOT NULL,
  page_index integer NOT NULL DEFAULT 0,
  pos_x numeric(8,6) NOT NULL,
  pos_y numeric(8,6) NOT NULL,
  width numeric(8,6) NOT NULL,
  height numeric(8,6) NOT NULL,
  required boolean NOT NULL DEFAULT true,
  placeholder text,
  value text,                            -- typed text / ISO date / 'true'|'false'
  filled_at timestamp with time zone,
  font_size numeric,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT esign_fields_pkey PRIMARY KEY (id),
  CONSTRAINT esign_fields_envelope_fkey FOREIGN KEY (envelope_id)
    REFERENCES public.esign_envelopes(id) ON DELETE CASCADE,
  CONSTRAINT esign_fields_signer_fkey FOREIGN KEY (signer_id)
    REFERENCES public.esign_signers(id) ON DELETE CASCADE,
  CONSTRAINT esign_fields_type_check CHECK (field_type IN
    ('signature','initials','date','text','checkbox'))
);

CREATE INDEX IF NOT EXISTS idx_esign_fields_envelope ON public.esign_fields(envelope_id, page_index);
CREATE INDEX IF NOT EXISTS idx_esign_fields_signer ON public.esign_fields(signer_id);

-- ───────────────────────────── events ─────────────────────────────
-- Append-only legal/audit trail. Server-written only (trustworthy IPs).
CREATE TABLE IF NOT EXISTS public.esign_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  envelope_id uuid NOT NULL,
  signer_id uuid,                        -- NULL for envelope-level events
  event_type text NOT NULL,
  ip inet,
  user_agent text,
  metadata jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT esign_events_pkey PRIMARY KEY (id),
  CONSTRAINT esign_events_envelope_fkey FOREIGN KEY (envelope_id)
    REFERENCES public.esign_envelopes(id) ON DELETE CASCADE,
  CONSTRAINT esign_events_signer_fkey FOREIGN KEY (signer_id)
    REFERENCES public.esign_signers(id) ON DELETE SET NULL,
  CONSTRAINT esign_events_type_check CHECK (event_type IN
    ('created','sent','viewed','signed','declined','completed','voided',
     'reminder_sent','consent_accepted'))
);

CREATE INDEX IF NOT EXISTS idx_esign_events_envelope ON public.esign_events(envelope_id, created_at);
CREATE INDEX IF NOT EXISTS idx_esign_events_signer ON public.esign_events(signer_id);

-- ───────────────────────────── templates ─────────────────────────────
-- Reusable library, scoped by owner_account_id (clients get their own; TD's are
-- NULL-owner globals). Instantiation copies template_fields into esign_fields.
CREATE TABLE IF NOT EXISTS public.esign_templates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_account_id uuid,                 -- soft ref accounts(id); NULL = TD global
  name text NOT NULL,
  description text,
  pdf_storage_path text NOT NULL,
  page_count integer,
  status text NOT NULL DEFAULT 'active',
  created_by text NOT NULL DEFAULT 'system',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT esign_templates_pkey PRIMARY KEY (id),
  CONSTRAINT esign_templates_status_check CHECK (status IN ('active','archived'))
);

CREATE INDEX IF NOT EXISTS idx_esign_templates_owner ON public.esign_templates(owner_account_id);

CREATE TABLE IF NOT EXISTS public.esign_template_fields (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL,
  signer_role_index integer NOT NULL DEFAULT 0,
  field_type text NOT NULL,
  page_index integer NOT NULL DEFAULT 0,
  pos_x numeric(8,6) NOT NULL,
  pos_y numeric(8,6) NOT NULL,
  width numeric(8,6) NOT NULL,
  height numeric(8,6) NOT NULL,
  default_required boolean NOT NULL DEFAULT true,
  placeholder text,
  font_size numeric,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT esign_template_fields_pkey PRIMARY KEY (id),
  CONSTRAINT esign_template_fields_template_fkey FOREIGN KEY (template_id)
    REFERENCES public.esign_templates(id) ON DELETE CASCADE,
  CONSTRAINT esign_template_fields_type_check CHECK (field_type IN
    ('signature','initials','date','text','checkbox'))
);

CREATE INDEX IF NOT EXISTS idx_esign_template_fields_template
  ON public.esign_template_fields(template_id);

-- ─────────────────────── per-account settings ───────────────────────
-- Per-account sender identity + quota. esign_enabled gates the portal product
-- (off by default; turned on for active-tier accounts at client launch).
CREATE TABLE IF NOT EXISTS public.esign_account_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,              -- soft ref accounts(id)
  sender_name text,
  reply_to text,
  default_message text,
  monthly_quota integer,
  sent_this_period integer NOT NULL DEFAULT 0,
  period_resets_at timestamp with time zone,
  white_label_domain text,
  esign_enabled boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT esign_account_settings_pkey PRIMARY KEY (id),
  CONSTRAINT esign_account_settings_account_key UNIQUE (account_id)
);

-- ──────────────── atomic last-signer completion gate ────────────────
-- Single UPDATE so concurrent signer submits cannot double-count. Pair with the
-- app-side `status <> 'signed'` TOCTOU guard on the signer row.
CREATE OR REPLACE FUNCTION public.increment_esign_signed_count(envelope_uuid uuid)
RETURNS integer
LANGUAGE sql
AS $$
  UPDATE public.esign_envelopes
  SET signed_count = signed_count + 1,
      updated_at = now()
  WHERE id = envelope_uuid
  RETURNING signed_count;
$$;

-- ───────────────────────────── RLS ─────────────────────────────
-- Defense-in-depth. Staff-only TO authenticated; anon + client-JWT denied;
-- service role bypasses (the app's actual access path).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'esign_envelopes','esign_signers','esign_fields','esign_events',
    'esign_templates','esign_template_fields','esign_account_settings'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', t || '_staff', t);
    EXECUTE format($f$
      CREATE POLICY %I ON public.%I
        FOR ALL TO authenticated
        USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
        WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');
    $f$, t || '_staff', t);
  END LOOP;
END $$;

COMMENT ON TABLE public.esign_envelopes IS
  'E-Sign envelopes (the document being signed). Multi-tenant via owner_account_id + origin. New esign_* family; does not touch signature_requests. 2026-06-26.';
COMMENT ON TABLE public.esign_signers IS
  'Per-signer state, generalizes oa_signatures. Third parties have NULL contact_id. Atomic completion via increment_esign_signed_count. 2026-06-26.';
COMMENT ON TABLE public.esign_events IS
  'Append-only e-sign legal/audit trail (server-written; trustworthy IPs). 2026-06-26.';
