-- Add itin_renewal_upcoming to action_events catalog.
-- Scope is "contact" because ITIN is personal, not company-scoped.
INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata)
VALUES (
  'action_events',
  'itin_renewal_upcoming',
  'ITIN renewal upcoming',
  'active',
  '{"scope":"contact","next_step":"Initiate ITIN renewal — file Form W-7 with 1040-NR","default_assignee":"Luca"}'::jsonb
)
ON CONFLICT (catalog_id, slug) DO NOTHING;
