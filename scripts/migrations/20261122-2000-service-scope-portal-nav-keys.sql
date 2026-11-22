-- Service-scoped portal login: which menu entries a bought service ADDS to the limited login (Antonio, 22 Nov 2026, dev job 6f555c9f).
-- A client who buys one service on its own (a "One-Time" company) sees only that service and what relates to it. The few entries that belong to one
-- particular service live on that service's catalog row as `metadata.portal_nav_keys` (read by lib/portal/service-scope-server.ts), not in code:
-- today only Banking adds one back — "Bank Applications". Every other service adds nothing (its steps arrive as cards on the overview, in Sign Documents,
-- in Documents and in the chat, which every limited login has).
-- Data only (one metadata key on one catalog row); idempotent (a row that already carries the key is left alone, so an edit made later in /catalog is never
-- overwritten); a missing row changes nothing and the code then simply adds nothing back (the login stays limited, never wider).
-- Apply to the SANDBOX first (node scripts/apply-migration.js <file>); Antonio applies it on production with the rest.
BEGIN;
SET LOCAL lock_timeout = '5s';

UPDATE public.catalog_entries
   SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{portal_nav_keys}', '["nav.bankApplications"]'::jsonb)
 WHERE catalog_id = 'services'
   AND slug = 'banking'
   AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'portal_nav_keys');

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.catalog_entries WHERE catalog_id = 'services' AND slug = 'banking')
     AND NOT EXISTS (SELECT 1 FROM public.catalog_entries WHERE catalog_id = 'services' AND slug = 'banking' AND metadata ? 'portal_nav_keys') THEN
    RAISE EXCEPTION 'service-scope-portal-nav-keys: the banking row has no portal_nav_keys after the change';
  END IF;
END
$do$;
COMMIT;

SELECT slug, metadata->'portal_nav_keys' AS portal_nav_keys FROM public.catalog_entries WHERE catalog_id = 'services' AND metadata ? 'portal_nav_keys';
