-- UNDO of 20261113-1710-booking-kinds-catalog.sql. Run it LAST of the four booking UNDOs (contact_calls, call_checks, booking_links first).
-- Removes the four seeded kinds (and any kind added since), the catalog definition and the name index. booking_links.kind_entry_id is ON DELETE SET NULL and
-- every link keeps its own pinned rule snapshot, so removing the catalog rows never changes a link already made.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"booking-kinds-undo"}', true);

DROP INDEX IF EXISTS public.uq_catalog_entries_booking_kind_name;
DELETE FROM public.catalog_entries WHERE catalog_id = 'booking_kinds';
DELETE FROM public.catalog_definitions WHERE id = 'booking_kinds';

COMMIT;
