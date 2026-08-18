-- migration:20260817-1901-seed-whats-new-recurring-invoice-event.sql
--
-- What's New catalog row for the new recurring_invoice_generated chat-event
-- kind (lib/portal/chat-events.ts), fired by the recurring-invoices cron.
-- Without this row the event still shows in What's New (unregistered keys
-- default visible — app/api/crm/admin-actions/whats-new/route.ts), just
-- without a friendly label or an on/off toggle in Board Settings. Idempotent,
-- same pattern as 20260814-1500-seed-whats-new-plan-referrer-event.sql.
-- Antonio's requested wording (card 4a854806): "Recurring invoice created —
-- release it."

INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata) VALUES
  ('whats_new_events','recurring_invoice_generated','Recurring invoice created — release it.','active','{"visible":true,"order":30}'::jsonb)
ON CONFLICT (catalog_id, slug) DO UPDATE
  SET display_name = EXCLUDED.display_name, status = 'active',
      metadata = EXCLUDED.metadata, updated_at = now();
