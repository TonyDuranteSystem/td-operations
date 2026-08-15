-- migration:20260814-1500-seed-whats-new-plan-referrer-event.sql
--
-- What's New catalog row for the new plan_referrer_ready_to_release chat-event
-- kind (lib/portal/chat-events.ts), fired by the plan-referrer-notify cron.
-- Without this row the event still shows in What's New (unregistered keys
-- default visible — app/api/crm/admin-actions/whats-new/route.ts), just
-- without a friendly label or an on/off toggle in Board Settings. Idempotent,
-- same pattern as 20260523-1200-seed-whats-new-events.sql.

INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata) VALUES
  ('whats_new_events','plan_referrer_ready_to_release','Payment plan ready — release commission','active','{"visible":true,"order":25}'::jsonb)
ON CONFLICT (catalog_id, slug) DO UPDATE
  SET display_name = EXCLUDED.display_name, status = 'active',
      metadata = EXCLUDED.metadata, updated_at = now();
