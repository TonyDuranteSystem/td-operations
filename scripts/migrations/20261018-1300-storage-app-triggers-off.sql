-- TD Storage Mac app: switch the three change-feed triggers OFF (no data loss, instantly reversible). A rung of the rollback ladder, between
-- "empty the allow-list" and "revert the code". While OFF the Macs' feed gets no new rows; run -triggers-on.sql afterwards (it makes every Mac
-- do one full refresh). Rehearsed on the sandbox before production (dev job 1992a087).
ALTER TABLE public.store_files   DISABLE TRIGGER trg_store_change_log_file;
ALTER TABLE public.store_folders DISABLE TRIGGER trg_store_change_log_folder;
ALTER TABLE public.store_owners  DISABLE TRIGGER trg_store_change_log_owner;
