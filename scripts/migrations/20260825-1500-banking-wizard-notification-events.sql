-- dev job fb527ac8 — banking wizard submissions never surfaced in the staff
-- "What's New" panel or the Notification Center board. Part of that fix:
-- the pre-seeded 'banking_wizard_submitted' action_events row (2026-05-21)
-- had one generic next-step for both providers ("Process / monitor
-- application"). Splitting into per-provider rows so the card names the bank,
-- matching the wording style already used elsewhere for these two providers
-- (lib/notifications/whats-new-defaults.ts's banking_review_payset/relay).
--
-- The original 'banking_wizard_submitted' row is left in place, unused —
-- it was never called from any code path, so leaving it costs nothing and
-- avoids a needless delete on a catalog row nothing references.
-- Idempotent: ON CONFLICT DO UPDATE. Safe to re-run.

INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata) VALUES
  ('action_events','banking_wizard_submitted_payset','Payset banking wizard submitted','active','{"next_step":"Process / monitor the Payset banking application","scope":"account","default_assignee":"Luca"}'::jsonb),
  ('action_events','banking_wizard_submitted_relay','Relay banking wizard submitted','active','{"next_step":"Process / monitor the Relay banking application","scope":"account","default_assignee":"Luca"}'::jsonb)
ON CONFLICT (catalog_id, slug) DO UPDATE
  SET display_name = EXCLUDED.display_name, status = 'active',
      metadata = EXCLUDED.metadata, updated_at = now();
