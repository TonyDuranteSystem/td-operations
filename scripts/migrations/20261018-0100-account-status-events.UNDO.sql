DROP TRIGGER IF EXISTS trg_log_account_status_change ON accounts;
DROP FUNCTION IF EXISTS log_account_status_change();
DROP TABLE IF EXISTS account_status_events;
