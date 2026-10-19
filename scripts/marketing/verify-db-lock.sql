-- READ-ONLY verification of the marketing database lock (TD Marketing council fix, 2026-10-18). Run in the Supabase SQL editor after the
-- migrations. EVERY query must return ZERO rows. Nothing here changes anything.

-- 1. public tables (not marketing's own) that do NOT carry the marketing_blocked policy
SELECT c.relname AS table_without_marketing_lock
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname NOT LIKE 'marketing\_%' ESCAPE '\'
  AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname AND p.policyname = 'marketing_blocked');

-- 2. public tables with row-level security OFF (a logged-in token could read them in full)
SELECT c.relname AS table_with_rls_off
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity;

-- 3. public views / materialized views a logged-in token may read (a view runs with its owner's rights and ignores the table locks)
SELECT c.relname AS view_readable_by_logged_in_users
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm') AND has_table_privilege('authenticated', c.oid, 'SELECT');

-- 4. owner-rights functions a logged-in token may run (expected: only get_client_account_ids, get_client_contact_id, comm_can_read,
--    store_staging_upload_allowed and the two marketing_my_* helpers; anything else needs a look)
SELECT p.proname AS owner_rights_function_open_to_logged_in_users
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  AND p.proname NOT IN ('get_client_account_ids', 'get_client_contact_id', 'comm_can_read', 'store_staging_upload_allowed',
                        'marketing_my_team_ids', 'marketing_my_owner_team_ids');

-- 5. anything anonymous visitors can still do beyond the three tables the public pages need
SELECT table_name || ' ' || string_agg(privilege_type, ',') AS anon_grant_outside_the_three
FROM information_schema.role_table_grants
WHERE grantee = 'anon' AND table_schema = 'public'
  AND table_name NOT IN ('form_8832_applications', 'signature_requests', 'member_info_requests')
GROUP BY table_name;
