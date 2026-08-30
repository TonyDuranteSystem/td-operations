-- migration:20260830-2200-seed-whats-new-card-autopay-event.sql
--
-- What's New catalog row for the new card_autopay_enabled chat-event kind
-- (lib/portal/chat-events.ts), fired by saveAutopayCard() (dev job 10995181
-- follow-up — the account/contact "Finance" summary card). Without this row
-- the event still shows in What's New (unregistered keys default visible —
-- app/api/crm/admin-actions/whats-new/route.ts), just without a friendly
-- label or an on/off toggle in Board Settings. Idempotent, same pattern as
-- 20260814-1500-seed-whats-new-plan-referrer-event.sql.

INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata) VALUES
  ('whats_new_events','card_autopay_enabled','Client turned on card autopay','active','{"visible":true,"order":120}'::jsonb)
ON CONFLICT (catalog_id, slug) DO UPDATE
  SET display_name = EXCLUDED.display_name, status = 'active',
      metadata = EXCLUDED.metadata, updated_at = now();
