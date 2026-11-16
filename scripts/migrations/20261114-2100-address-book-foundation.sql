-- Address book, step 1 "Foundation" (dev job 055f2400, Antonio 2026-11-14 "Yes, start 0-1"). SANDBOX FIRST; production only on Antonio's word.
--
-- The address book is STANDALONE. It READS the CRM (contacts + partners) and saves the OTHER people who have no place in the CRM. It never writes to, and never
-- adds a foreign key to, the contacts table or the Contacts page (86 tables already point at contacts; the WhatsApp matcher, name suggestions and the AI
-- search read every contact, so a person saved here must never be one).
--
-- Three small tables + one catalog (no seed rows: Antonio creates his own types in the address book, nothing is hard-coded):
--   address_book_entries     the COMPANY book: people saved here. Plain columns (the team searches and filters them). type_entry_id -> catalog row.
--                            extra = the values of that type's own boxes, keyed by box key (validated in code against the type's boxes).
--   address_book_personal    the PERSONAL book: ONE encrypted payload per person (AES-256-GCM, code: lib/address-book/crypto.ts), owned by ONE login.
--                            No readable column holds a name or number. Anything that can read the table (an admin SQL tool, a Claude session) sees scrambled text.
--                            The AI read-only role is also revoked, so the Slack worker and Hermes crm_query cannot even select it.
--   address_book_crm_labels  the type Antonio CONFIRMS for a CRM person (e.g. one of the 109 "not sorted"). Kept here so the Contacts data is never changed.
--                            subject_id has NO foreign key on purpose: it must never constrain, merge-block or delete anything in contacts / partners.
-- Catalog 'address_book_types': slug = stable id, display_name = the name shown, metadata = {"boxes":[{"key","label","kind"}],"color","sort_order"}.
--   kind is one of text | date | number | yesno (validated in code). Hiding a type = status 'deprecated'; its people keep working and show as unsorted.
--
-- Values that live in code, no CHECK list on purpose: address_book_entries.source (typed | email | whatsapp | card | other), address_book_crm_labels.subject_kind (contact | partner).
-- Locked: RLS on, no access for anon/authenticated (service client only), marketing lock re-run (lib/security/migration-lock-check.ts).
-- UNDO: 20261114-2100-address-book-foundation.UNDO.sql

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"address-book-migration"}', true);

INSERT INTO public.catalog_definitions (id, display_name, display_name_translations, description, admin_can_add_rows)
VALUES (
  'address_book_types',
  'Address book types',
  '{"it":"Tipi di rubrica"}'::jsonb,
  'The kinds of person the address book can hold (Supplier, Lawyer, Accountant, ...), created by Antonio in the address book. Slug = stable id (never changed). display_name = the name shown. metadata = {"boxes":[{"key","label","kind"}],"color","sort_order"}: the extra boxes of that type (kind = text | date | number | yesno). A type is hidden with status deprecated, never deleted.',
  true
)
ON CONFLICT (id) DO NOTHING;

-- Two types may not share a name apart from capitals / spaces (hidden ones included). The accent-insensitive part of the check lives in code.
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_entries_address_book_type_name
  ON public.catalog_entries (lower(btrim(display_name)))
  WHERE catalog_id = 'address_book_types';

CREATE TABLE IF NOT EXISTS public.address_book_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_entry_id    uuid REFERENCES public.catalog_entries(id) ON DELETE SET NULL,
  full_name        text NOT NULL,
  company          text,
  job_title        text,
  website          text,
  phones           text[] NOT NULL DEFAULT '{}',
  phone_keys       text[] NOT NULL DEFAULT '{}',
  emails           text[] NOT NULL DEFAULT '{}',
  address          text,
  notes            text,
  extra            jsonb NOT NULL DEFAULT '{}'::jsonb,
  source           text NOT NULL DEFAULT 'typed',
  source_ref       jsonb,
  card_file_path   text,
  created_by       uuid,
  created_by_email text,
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN public.address_book_entries.phone_keys IS 'Digits-only copy of phones, written by code, used to find "already saved" by phone.';
COMMENT ON COLUMN public.address_book_entries.emails IS 'Lower-case, written by code, used to find "already saved" by email.';
CREATE INDEX IF NOT EXISTS idx_address_book_entries_type ON public.address_book_entries (type_entry_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_address_book_entries_phone_keys ON public.address_book_entries USING gin (phone_keys);
CREATE INDEX IF NOT EXISTS idx_address_book_entries_emails ON public.address_book_entries USING gin (emails);
CREATE INDEX IF NOT EXISTS idx_address_book_entries_created ON public.address_book_entries (created_at DESC) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS public.address_book_personal (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  uuid NOT NULL,
  payload_enc    text NOT NULL,
  archived_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN public.address_book_personal.owner_user_id IS 'The signed-in user (auth user id) who owns the person. Also bound into the encryption (AAD), so a payload cannot be moved to another owner.';
COMMENT ON COLUMN public.address_book_personal.payload_enc IS 'v1.<iv>.<tag>.<ciphertext> (base64url), AES-256-GCM of the whole person as JSON. Never plain text.';
CREATE INDEX IF NOT EXISTS idx_address_book_personal_owner ON public.address_book_personal (owner_user_id, created_at DESC) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS public.address_book_crm_labels (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind        text NOT NULL,
  subject_id          uuid NOT NULL,
  type_entry_id       uuid REFERENCES public.catalog_entries(id) ON DELETE SET NULL,
  confirmed_by_email  text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_kind, subject_id)
);
COMMENT ON COLUMN public.address_book_crm_labels.subject_id IS 'A contacts.id or partners.id. NO foreign key on purpose: the address book must never constrain, block or follow a change in the CRM tables. A label whose person is gone or merged is ignored by code.';

ALTER TABLE public.address_book_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.address_book_entries FROM anon, authenticated;
ALTER TABLE public.address_book_personal ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.address_book_personal FROM anon, authenticated;
ALTER TABLE public.address_book_crm_labels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.address_book_crm_labels FROM anon, authenticated;

-- The Personal book is kept away from the AI read-only role too (the Slack worker and Hermes crm_query run as ai_readonly; "a NEW secret table must be REVOKE'd from ai_readonly",
-- see 20260721-1200-ai-readonly-role.sql). The role exists where that migration ran; skip quietly where it does not.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_readonly') THEN
    REVOKE ALL ON public.address_book_personal FROM ai_readonly;
  END IF;
END $$;

SELECT public.marketing_lock_all_tables();

COMMIT;

-- verify (the Supabase SQL editor shows only this LAST result): RLS on, client_grants 0 for all three; ai_can_read_personal must be false
SELECT c.relname AS table_name, c.relrowsecurity AS rls_on,
       (SELECT count(*) FROM information_schema.role_table_grants g WHERE g.table_schema = 'public' AND g.table_name = c.relname AND g.grantee IN ('anon', 'authenticated')) AS client_grants,
       CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_readonly')
            THEN has_table_privilege('ai_readonly', ('public.' || c.relname)::regclass, 'SELECT') END AS ai_can_read
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname IN ('address_book_entries', 'address_book_personal', 'address_book_crm_labels')
 ORDER BY c.relname;
