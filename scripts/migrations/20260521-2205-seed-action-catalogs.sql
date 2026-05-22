-- Notification Center Phase 1 — seed catalogs (kanban columns + event taxonomy)
-- See sysdoc 'notification-center-plan' (dev_task 529b26cc).
-- Catalog-driven so columns / next-steps / owners are editable without a deploy.
-- Idempotent: ON CONFLICT DO UPDATE. Safe to re-run.

-- Register the two catalogs in the parent registry first
-- (catalog_entries.catalog_id -> catalog_definitions.id). admin_can_add_rows=true
-- so Antonio can add/edit columns + events from the catalog UI without a deploy.
INSERT INTO catalog_definitions (id, display_name, description, admin_can_add_rows) VALUES
  ('action_board_columns','Action Board Columns','Kanban columns for the staff Notification Center board (Action needed -> ... -> Done).', true),
  ('action_events','Action Events','Client-action events that create staff action cards: next step, scope (contact/account), owner.', true)
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name, description = EXCLUDED.description, updated_at = now();

-- Kanban columns. A card's message_actions.action_type = the column slug.
-- Reuses the existing tag slugs (action_needed/in_progress/waiting_on_client/done)
-- so legacy manually-tagged rows map straight onto columns. 'done' is terminal.
INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata) VALUES
  ('action_board_columns','action_needed','Action needed','active','{"order":10}'::jsonb),
  ('action_board_columns','in_progress','In progress','active','{"order":20}'::jsonb),
  ('action_board_columns','waiting_on_client','Waiting on client','active','{"order":30}'::jsonb),
  ('action_board_columns','wait_for_irs','Wait for the IRS','active','{"order":40}'::jsonb),
  ('action_board_columns','done','Done','active','{"order":50,"terminal":true}'::jsonb)
ON CONFLICT (catalog_id, slug) DO UPDATE
  SET display_name = EXCLUDED.display_name, status = 'active',
      metadata = EXCLUDED.metadata, updated_at = now();

-- Event taxonomy: per client-action event -> next step, scope, owner.
-- scope is a hint; emitActionNeeded uses whichever of contact_id/account_id it is given.
INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata) VALUES
  ('action_events','itin_wizard_submitted','ITIN wizard submitted','active','{"next_step":"Review generated W-7 / 1040-NR","scope":"contact","default_assignee":"Luca"}'::jsonb),
  ('action_events','formation_wizard_submitted','Formation wizard submitted','active','{"next_step":"Verify data + check LLC name","scope":"contact","default_assignee":"Luca"}'::jsonb),
  ('action_events','onboarding_wizard_submitted','Onboarding wizard submitted','active','{"next_step":"Verify + RA change on Harbor","scope":"account","default_assignee":"Luca"}'::jsonb),
  ('action_events','tax_wizard_submitted','Tax wizard submitted','active','{"next_step":"Review tax data","scope":"account","default_assignee":"Antonio"}'::jsonb),
  ('action_events','banking_wizard_submitted','Banking wizard submitted','active','{"next_step":"Process / monitor application","scope":"account","default_assignee":"Luca"}'::jsonb),
  ('action_events','ss4_signed','SS-4 signed','active','{"next_step":"Fax to IRS","scope":"account","default_assignee":"Luca"}'::jsonb),
  ('action_events','tax_return_signed','Tax return signed','active','{"next_step":"Send to India to file","scope":"account","default_assignee":"Luca"}'::jsonb),
  ('action_events','itin_number_provided','Client provided ITIN number','active','{"next_step":"Update contact info","scope":"contact","default_assignee":"Luca"}'::jsonb)
ON CONFLICT (catalog_id, slug) DO UPDATE
  SET display_name = EXCLUDED.display_name, status = 'active',
      metadata = EXCLUDED.metadata, updated_at = now();
