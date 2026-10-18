-- TD Storage Mac app: switch the three change-feed triggers back ON, and tell every Mac to do one full refresh (changes made while the
-- triggers were off are not in the feed). Counterpart of 20261018-1300-storage-app-triggers-off.sql.
ALTER TABLE public.store_files   ENABLE TRIGGER trg_store_change_log_file;
ALTER TABLE public.store_folders ENABLE TRIGGER trg_store_change_log_folder;
ALTER TABLE public.store_owners  ENABLE TRIGGER trg_store_change_log_owner;
-- every cursor handed out before now is "too old": the next call answers resync and Finder lists everything again
UPDATE public.store_change_floor SET floor_txid = pg_current_xact_id() WHERE id = 1;
