-- UNDO for 20261017-0100-storage-app-p0.sql (drops only what that migration created).
-- ORDER OF A ROLLBACK: first revert the code / the nightly cron (otherwise /api/cron/storage-app-prune fails every night on missing functions),
-- THEN run this file. Cheaper first rungs: empty the allow-list, then 20261018-1300-storage-app-triggers-off.sql (no data loss).
DROP TRIGGER IF EXISTS trg_store_change_log_file ON public.store_files;
DROP TRIGGER IF EXISTS trg_store_change_log_folder ON public.store_folders;
DROP TRIGGER IF EXISTS trg_store_change_log_owner ON public.store_owners;
DROP TRIGGER IF EXISTS trg_store_change_log_account ON public.accounts;
DROP TRIGGER IF EXISTS trg_store_change_log_contact ON public.contacts;
DROP FUNCTION IF EXISTS public.store_change_log_file();
DROP FUNCTION IF EXISTS public.store_change_log_folder();
DROP FUNCTION IF EXISTS public.store_change_log_owner();
DROP FUNCTION IF EXISTS public.store_change_log_account();
DROP FUNCTION IF EXISTS public.store_change_log_contact();
DROP FUNCTION IF EXISTS public.store_changes_since(xid8, bigint, int);
DROP FUNCTION IF EXISTS public.store_changes_head();
DROP FUNCTION IF EXISTS public.store_change_log_prune(interval);
DROP FUNCTION IF EXISTS public.storage_app_prune();
DROP TABLE IF EXISTS public.store_change_floor;
DROP TABLE IF EXISTS public.store_change_log;
DROP TABLE IF EXISTS public.storage_app_tokens;
DROP TABLE IF EXISTS public.storage_app_auth_codes;
DROP TABLE IF EXISTS public.storage_app_devices;
