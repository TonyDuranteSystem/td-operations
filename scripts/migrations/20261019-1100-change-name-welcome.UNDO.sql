-- UNDO of 20261019-1100-change-name-welcome.sql — removes the Company Change Name welcome row (a name change then gets the generic notice again).
BEGIN;
SET LOCAL lock_timeout = '5s';
DELETE FROM public.catalog_entries WHERE catalog_id = 'welcome_messages' AND slug = 'company_change_name';
COMMIT;
SELECT 'change-name-welcome undone' AS result;
