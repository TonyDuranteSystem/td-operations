-- Storage check Phase 2, slice 3b (dev job d14e823f): staff can open ONE older item (invoice, expense, payment, message,
-- notice...) to people whose view of the company starts at a later date. One small table for every kind of item, so no
-- column is added to the busy tables. Documents keep their own column (documents.visible_to_new_owners).
CREATE TABLE IF NOT EXISTS history_item_overrides (
  item_kind  text        NOT NULL,
  item_id    uuid        NOT NULL,
  account_id uuid        NOT NULL,
  opened_by  text,
  opened_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_kind, item_id)
);
CREATE INDEX IF NOT EXISTS idx_history_item_overrides_account ON history_item_overrides (account_id, item_kind);
ALTER TABLE history_item_overrides ENABLE ROW LEVEL SECURITY;
