-- dev job 9b7892d6 -- client confirming their P&L and Balance Sheet only ever
-- created an old-style plain task (no Notification Center card, no What's New
-- note). This seeds the missing catalog row so emitActionNeeded() can create
-- a proper card the moment the attest route calls it. Without this row,
-- emitActionNeeded silently no-ops (unknown_event) -- the exact "confirmation
-- recorded but staff never told" failure this fix exists to close.
-- Idempotent: ON CONFLICT DO UPDATE. Safe to re-run.

INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata) VALUES
  ('action_events','financials_confirmed','Client confirmed financials','active','{"next_step":"Do the final pass on the client-confirmed financials, then send to the accountant","scope":"account","default_assignee":"Luca"}'::jsonb)
ON CONFLICT (catalog_id, slug) DO UPDATE
  SET display_name = EXCLUDED.display_name, status = 'active',
      metadata = EXCLUDED.metadata, updated_at = now();
