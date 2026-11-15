-- UNDO of 20261114-2100-address-book-foundation.sql. Forgets every person saved in the address book (Company and Personal) and every type confirmed for a CRM person, and
-- the address book's own list of types. Nothing in the CRM (contacts, partners, accounts) is touched. Personal rows are encrypted, so a copy of this table
-- cannot be re-read without the key: take a backup first only if you mean to keep them.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"address-book-migration"}', true);

DROP TABLE IF EXISTS public.address_book_crm_labels;
DROP TABLE IF EXISTS public.address_book_personal;
DROP TABLE IF EXISTS public.address_book_entries;

DROP INDEX IF EXISTS public.uq_catalog_entries_address_book_type_name;
-- the catalog rows go through the decision log like any catalog change: delete the entries, then the definition
DELETE FROM public.catalog_decision_log WHERE catalog_id = 'address_book_types';
DELETE FROM public.catalog_entries WHERE catalog_id = 'address_book_types';
DELETE FROM public.catalog_definitions WHERE id = 'address_book_types';

COMMIT;
