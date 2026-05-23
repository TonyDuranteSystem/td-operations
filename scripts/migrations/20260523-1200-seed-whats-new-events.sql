-- migration:20260523-1200-seed-whats-new-events.sql
--
-- Notification Center integration Step 2 — per-event show/hide for "What's New".
-- One catalog row per event type; staff toggle visibility from Board Settings.
-- The What's New feed AND the purple-dot count both read this single config.
--
-- Event identity (entry slug = event_key):
--   • chat-event kinds: payment_received, ss4_signed, document_uploaded
--   • workflow_spawned notes are keyed by the workflow slug (formation_progress,
--     onboarding_progress, closure_progress, itin_review, banking_review_payset,
--     banking_review_relay, banking_physical_progress, tax_form_review) so e.g.
--     Formation and Closure are INDEPENDENT switches.
-- metadata.visible = whether it shows in What's New (and counts toward the dot).
-- Defaults: signal events ON; document uploads OFF (Antonio: uploads = noise).
--
-- See sysdoc notification-center-workflow-integration-plan. Idempotent.

INSERT INTO catalog_definitions (id, display_name, description, admin_can_add_rows) VALUES
  ('whats_new_events','What''s New events','Which client-action events appear in the staff What''s New feed (and count toward the purple dot). Toggle each on/off.', true)
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name, description = EXCLUDED.description, updated_at = now();

INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata) VALUES
  ('whats_new_events','payment_received','Client paid','active','{"visible":true,"order":10}'::jsonb),
  ('whats_new_events','ss4_signed','Client signed SS-4','active','{"visible":true,"order":20}'::jsonb),
  ('whats_new_events','itin_review','Client submitted ITIN','active','{"visible":true,"order":30}'::jsonb),
  ('whats_new_events','banking_review_payset','Client submitted Banking (Payset)','active','{"visible":true,"order":40}'::jsonb),
  ('whats_new_events','banking_review_relay','Client submitted Banking (Relay)','active','{"visible":true,"order":50}'::jsonb),
  ('whats_new_events','banking_physical_progress','Banking — physical card','active','{"visible":true,"order":60}'::jsonb),
  ('whats_new_events','tax_form_review','Client submitted Tax','active','{"visible":true,"order":70}'::jsonb),
  ('whats_new_events','formation_progress','Client started Formation','active','{"visible":true,"order":80}'::jsonb),
  ('whats_new_events','onboarding_progress','Client started Onboarding','active','{"visible":true,"order":90}'::jsonb),
  ('whats_new_events','closure_progress','Client started Closure','active','{"visible":true,"order":100}'::jsonb),
  ('whats_new_events','document_uploaded','Client uploaded a document','active','{"visible":false,"order":110}'::jsonb)
ON CONFLICT (catalog_id, slug) DO UPDATE
  SET display_name = EXCLUDED.display_name, status = 'active',
      metadata = EXCLUDED.metadata, updated_at = now();
