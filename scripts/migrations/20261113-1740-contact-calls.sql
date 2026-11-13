-- Booking page, Stage 1a (dev job 19d2654a). M4 of 4: "contact_calls" — a thin APPEND-ONLY LOG of calls booked by someone who is already a contact
-- (a client or partner booking through a link whose kind says "attach"). lead_calls cannot hold them (its lead_id is NOT NULL and lead-only).
--
-- Deliberately small: NO done state, NO recording matching, NO change to the Circleback route. Calls that really happened are already shown from call_summaries;
-- the contact page lists a log row as "Booked call" only while no call summary exists for that day. The Zoom filing reads the log (tolerant) so a client call that
-- overlaps a marketing window is not filed as marketing.
--   state   scheduled | moved | cancelled   (values live in code; no CHECK list on purpose). 'moved' is set when Calendly re-fires invitee.created for a reschedule
--           (old_invitee names the old booking); moved_to points at the new row. 'cancelled' is only ever set on positive Calendly evidence (Stage 2).
-- contact_id is a REAL foreign key ON DELETE CASCADE (merge_contacts re-points it). Never add a UNIQUE that includes contact_id (the merge does a plain UPDATE).
-- Locked: RLS on, no access for anon/authenticated (service client only).
-- UNDO: 20261113-1740-contact-calls.UNDO.sql (run FIRST of the four UNDOs).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.contact_calls (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id          uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  account_id          uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  booking_link_id     uuid REFERENCES public.booking_links(id) ON DELETE SET NULL,
  booked_at           timestamptz,
  scheduled_start     timestamptz,
  scheduled_date      date,
  calendly_event_uri  text,
  event_type_name     text,
  state               text NOT NULL DEFAULT 'scheduled',
  moved_to            uuid REFERENCES public.contact_calls(id) ON DELETE SET NULL,
  source              text NOT NULL DEFAULT 'calendly',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_calls_event_uri ON public.contact_calls (calendly_event_uri) WHERE calendly_event_uri IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contact_calls_contact ON public.contact_calls (contact_id, scheduled_start);
CREATE INDEX IF NOT EXISTS idx_contact_calls_start ON public.contact_calls (scheduled_start);
CREATE INDEX IF NOT EXISTS idx_contact_calls_account ON public.contact_calls (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contact_calls_link ON public.contact_calls (booking_link_id) WHERE booking_link_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contact_calls_moved_to ON public.contact_calls (moved_to) WHERE moved_to IS NOT NULL;
ALTER TABLE public.contact_calls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_calls FROM anon, authenticated;

SELECT public.marketing_lock_all_tables();

COMMIT;
