-- Booking page, "People" (dev job 72ff781a, child of 19d2654a; Antonio 14 Nov 2026). Catalog DATA only: no table, no column, no function.
--
--   1. A fifth kind, "People": a person who is just a contact in the system — no lead, no company, no sales questions. A booking made on a link for that contact is
--      saved under the contact (existing_person = attach). If someone ELSE books on the link, the booking is kept as a lead like any other (new_person = lead): a
--      booking is never dropped. for_new_person = false: it is not offered for "Someone new" (a People link is made for a named contact).
--   2. Client is no longer offered for "Someone new" (a brand-new person cannot already be a client): for_new_person = false on the Client row. The rule itself
--      (what a booking does) is NOT changed, so a link already made behaves exactly as before; the page hides Client there and the server refuses it.
--
-- for_new_person is an optional extra beside the flat rule (absent = offered); it is not part of the rule pinned on a link and the webhook never reads it.
-- Re-run safe: the seed never overwrites a rename or a changed rule (ON CONFLICT DO NOTHING) and the Client update only fills the key when it is absent.
-- UNDO: 20261114-2100-booking-people-kind.UNDO.sql

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"booking-people-kind-migration"}', true);

INSERT INTO public.catalog_entries (catalog_id, slug, display_name, display_name_translations, status, metadata) VALUES
  ('booking_kinds', 'people', 'People', '{"it":"Persone"}'::jsonb, 'active', '{"existing_person":"attach","new_person":"lead","mark_lead":false,"sales_template":false,"for_new_person":false,"sort_order":50}'::jsonb)
ON CONFLICT (catalog_id, slug) DO NOTHING;

UPDATE public.catalog_entries
   SET metadata = metadata || '{"for_new_person":false}'::jsonb
 WHERE catalog_id = 'booking_kinds' AND slug = 'client' AND NOT (metadata ? 'for_new_person');

COMMIT;

-- verify (the Supabase SQL editor shows only this LAST result): five kinds; People and Client say for_new_person false
SELECT slug, display_name, status, metadata FROM public.catalog_entries WHERE catalog_id = 'booking_kinds' ORDER BY (metadata->>'sort_order')::int;
