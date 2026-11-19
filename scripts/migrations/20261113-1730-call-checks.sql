-- Booking page, Stage 1a (dev job 19d2654a). M3 of 4: "Calls to check" — one card per booking that needs a human look (follows the lead_client_checks precedent).
--
--   kind        unpaid_call | mismatch | unknown_id | effect_failed   (values live in code; no CHECK list on purpose)
--   dedupe_key  NOT NULL; one card per (kind, dedupe_key) — a plain UNIQUE constraint (supabase-js onConflict cannot use a partial index). Webhook redeliveries
--               use the Calendly invitee uri, so a repeat delivery never makes a second card.
--   status      open | answering | answered | dismissed   (answering = a click is being processed: the answer route claims first, acts, reverts on failure)
--   payload     what the card shows (names, the email that booked, ...), so the card never needs a join to read
-- lead_id and contact_id are REAL foreign keys ON DELETE CASCADE (a deleted lead takes its cards with it; merge_contacts re-points contact_id);
-- booking_link_id is SET NULL (the card outlives a deleted link).
-- Nothing reads this table until Stage 1b's Calendar tab; the webhook (Stage 1a) only writes to it and never fails because of it.
-- Locked: RLS on, no access for anon/authenticated (service client only).
-- UNDO: 20261113-1730-call-checks.UNDO.sql

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.call_checks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL,
  dedupe_key          text NOT NULL,
  status              text NOT NULL DEFAULT 'open',
  booking_link_id     uuid REFERENCES public.booking_links(id) ON DELETE SET NULL,
  lead_id             uuid REFERENCES public.leads(id) ON DELETE CASCADE,
  contact_id          uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  calendly_event_uri  text,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  answer              text,
  answered_by         text,
  answered_at         timestamptz,
  remind_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_call_checks_kind_dedupe UNIQUE (kind, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_call_checks_open ON public.call_checks (created_at DESC) WHERE status IN ('open', 'answering');
CREATE INDEX IF NOT EXISTS idx_call_checks_link ON public.call_checks (booking_link_id) WHERE booking_link_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_call_checks_lead ON public.call_checks (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_call_checks_contact ON public.call_checks (contact_id) WHERE contact_id IS NOT NULL;
ALTER TABLE public.call_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.call_checks FROM anon, authenticated;

SELECT public.marketing_lock_all_tables();

COMMIT;

-- verify (the Supabase SQL editor shows only this LAST result): row-level security must be on and anon/authenticated must hold no privileges, so client_grants must be 0
SELECT c.relname AS table_name, c.relrowsecurity AS rls_on,
       (SELECT count(*) FROM information_schema.role_table_grants g WHERE g.table_schema = 'public' AND g.table_name = c.relname AND g.grantee IN ('anon', 'authenticated')) AS client_grants
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'call_checks';
