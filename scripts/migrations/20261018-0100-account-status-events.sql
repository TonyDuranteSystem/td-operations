-- Storage check Phase 3 (dev job f855295a): every change of a company's status leaves ONE row, whichever screen or tool made it.
-- A cron turns those rows into a staff-only note in the Calendar's What's New (and, later, starts the reactivation step).
-- Nothing is changed on the accounts table itself; the trigger only records.
CREATE TABLE IF NOT EXISTS account_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  old_status text,
  new_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  handled_at timestamptz,
  handled_note text
);
CREATE INDEX IF NOT EXISTS account_status_events_unhandled ON account_status_events (created_at) WHERE handled_at IS NULL;
ALTER TABLE account_status_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION log_account_status_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO account_status_events (account_id, old_status, new_status) VALUES (NEW.id, OLD.status::text, NEW.status::text);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_log_account_status_change ON accounts;
CREATE TRIGGER trg_log_account_status_change
  AFTER UPDATE OF status ON accounts
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION log_account_status_change();
