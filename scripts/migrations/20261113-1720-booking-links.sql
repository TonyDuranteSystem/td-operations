-- Booking page, Stage 1a (dev job 19d2654a). M2 of 4: the links Antonio makes (one row per link).
--
-- A link is app.tonydurante.us/r/b/<public_id>: a random 22-character id (128 bits); a booking made through it carries the id in utm_term, the Calendly webhook
-- looks the row up and applies the rule pinned in rule_snapshot. No payment columns here: paid links are Stage 3 (an additive ALTER ... ADD COLUMN, nullable).
--
--   status            open | claimed          (values live in code; no CHECK list on purpose)
--   once              true = one booking closes the link (atomic claim); false = reusable (the 30-minute standard link), NEVER claims
--   person_emails     the person's emails SNAPSHOTTED at link creation (primary + email_2 + alt_emails); may be EMPTY (the first booker then claims and
--                     claimed_email feeds recording and payment); the mismatch test is skipped when it is empty
--   effects_done_at   set only after the kind's effect succeeded; a replay of a claimed link re-runs the (idempotent) effects until it is set
--   referral_outcome  what the referral step did for this booking (credited | not_new_person | no_referrer | mismatch | failed ...), so a credit that did not happen is never silent
-- Real foreign keys, all SET NULL: deleting a lead / contact / account / kind never deletes the link (the row keeps person_name and its pinned snapshot).
-- merge_contacts re-points contact FKs that are real, so contact_id and referrer_contact_id follow a merge.
-- Locked: RLS on, no access for anon/authenticated (service client only) — a client token must never read person_emails.
-- UNDO: 20261113-1720-booking-links.UNDO.sql

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.booking_links (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id            text NOT NULL,
  kind_label           text NOT NULL,
  kind_entry_id        uuid REFERENCES public.catalog_entries(id) ON DELETE SET NULL,
  rule_snapshot        jsonb NOT NULL DEFAULT '{}'::jsonb,
  rule_version         integer NOT NULL DEFAULT 1,
  contact_id           uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  account_id           uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  lead_id              uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  person_name          text,
  person_language      text,
  person_emails        text[] NOT NULL DEFAULT '{}'::text[],
  template_slug        text,
  duration_minutes     integer,
  share_url            text,
  once                 boolean NOT NULL DEFAULT true,
  status               text NOT NULL DEFAULT 'open',
  revoked_at           timestamptz,
  expires_at           timestamptz,
  claimed_invitee_uri  text,
  claimed_event_uri    text,
  claimed_at           timestamptz,
  claimed_email        text,
  effects_done_at      timestamptz,
  referrer_contact_id  uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  referrer_code        text,
  referral_outcome     text,
  open_count           integer NOT NULL DEFAULT 0,
  last_opened_at       timestamptz,
  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_booking_links_public_id UNIQUE (public_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_links_claimed_invitee ON public.booking_links (claimed_invitee_uri) WHERE claimed_invitee_uri IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_booking_links_claimed_event ON public.booking_links (claimed_event_uri) WHERE claimed_event_uri IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_booking_links_kind_entry ON public.booking_links (kind_entry_id) WHERE kind_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_booking_links_contact ON public.booking_links (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_booking_links_account ON public.booking_links (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_booking_links_lead ON public.booking_links (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_booking_links_referrer ON public.booking_links (referrer_contact_id) WHERE referrer_contact_id IS NOT NULL;
ALTER TABLE public.booking_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_links FROM anon, authenticated;

SELECT public.marketing_lock_all_tables();

COMMIT;
