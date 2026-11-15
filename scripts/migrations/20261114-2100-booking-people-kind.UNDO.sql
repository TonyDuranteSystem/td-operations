-- UNDO of 20261114-2100-booking-people-kind.sql. Removes the People kind and gives Client back to "Someone new".
-- booking_links.kind_entry_id is ON DELETE SET NULL and every link keeps its own pinned rule snapshot, so a link already made is not changed.
-- Contacts that were made for People links are NOT deleted (they are ordinary contacts, and a contact may already have calls on it).

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"booking-people-kind-undo"}', true);

DELETE FROM public.catalog_entries WHERE catalog_id = 'booking_kinds' AND slug = 'people';

UPDATE public.catalog_entries
   SET metadata = metadata - 'for_new_person'
 WHERE catalog_id = 'booking_kinds' AND slug = 'client';

COMMIT;
