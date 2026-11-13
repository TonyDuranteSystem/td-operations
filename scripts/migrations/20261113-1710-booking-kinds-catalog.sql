-- Booking page, Stage 1a (dev job 19d2654a, Antonio 2026-11-13 "Yes, start step 1"). M1 of 4: the list of "kinds" of booking link, as catalog data.
--
-- A KIND says what happens to a person's call: Lead / Client / Partner / Private are the four starting kinds; a fifth is a new catalog row, never new code.
-- Each kind's rule is FLAT metadata (no effect machinery):
--   existing_person  attach | lead | none   what a booking by someone who is already a CONTACT does ("lead" = today's behaviour: a lead + call row)
--   new_person       lead | none            what a booking by someone not yet in the system does
--   mark_lead        true | false           the lead this booking creates gets "Booking kind: <label>" as the first line of its notes
--   sales_template   true | false           a free call for a new person uses the Calendly template that asks the sales questions
--   sort_order       number                 order in the list
-- A link row pins a SNAPSHOT of the rule when it is made (booking_links.rule_snapshot), so renaming or retiring a kind never changes a link already sent.
-- A kind added through a generic catalog tool without this metadata shows "needs setup" in the maker and is refused (code, Stage 1b).
-- Retiring a kind writes status 'deprecated' (catalog_entries.status CHECK allows active|deprecated|exception_only|draft).
--
-- Seeds use ON CONFLICT DO NOTHING so a re-run never overwrites a rename, a retire or a changed rule.
-- The partial unique index keeps two kinds from having the same name apart from capitals / spaces (retired ones included); the accent-insensitive part of the
-- duplicate check lives in code (Stage 1b).
-- No table is created here (the lock call is in the migrations that create tables).
-- UNDO: 20261113-1710-booking-kinds-catalog.UNDO.sql (run LAST of the four UNDOs).

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"booking-kinds-migration"}', true);

INSERT INTO public.catalog_definitions (id, display_name, display_name_translations, description, admin_can_add_rows)
VALUES (
  'booking_kinds',
  'Booking kinds',
  '{"it":"Tipi di prenotazione"}'::jsonb,
  'The kinds of Calendly link the Booking page can make (Lead, Client, Partner, Private, ...). Slug = stable id (never changed). display_name = the name shown. metadata = the flat rule: existing_person (attach|lead|none), new_person (lead|none), mark_lead (bool), sales_template (bool), sort_order (number). A link pins a snapshot of the rule when it is made.',
  true
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.catalog_entries (catalog_id, slug, display_name, display_name_translations, status, metadata) VALUES
  ('booking_kinds', 'lead',    'Lead',    '{"it":"Lead"}'::jsonb,    'active', '{"existing_person":"lead","new_person":"lead","mark_lead":false,"sales_template":true,"sort_order":10}'::jsonb),
  ('booking_kinds', 'client',  'Client',  '{"it":"Cliente"}'::jsonb, 'active', '{"existing_person":"attach","new_person":"lead","mark_lead":false,"sales_template":false,"sort_order":20}'::jsonb),
  ('booking_kinds', 'partner', 'Partner', '{"it":"Partner"}'::jsonb, 'active', '{"existing_person":"attach","new_person":"lead","mark_lead":true,"sales_template":false,"sort_order":30}'::jsonb),
  ('booking_kinds', 'private', 'Private', '{"it":"Privata"}'::jsonb, 'active', '{"existing_person":"none","new_person":"none","mark_lead":false,"sales_template":false,"sort_order":40}'::jsonb)
ON CONFLICT (catalog_id, slug) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_entries_booking_kind_name
  ON public.catalog_entries (lower(btrim(display_name)))
  WHERE catalog_id = 'booking_kinds';

COMMIT;
