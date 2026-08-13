-- Card 4a39e0fd (Antonio's binding ruling 2026-08-12): a failed statement
-- ingest must raise a staff What's New card, not just a passive Exception
-- Center row. Scope is "account" — statements belong to the company's books.
INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata)
VALUES (
  'action_events',
  'statement_ingest_failed',
  'Bank statement could not be read',
  'active',
  '{"scope":"account","next_step":"Open the Exception Center / financials review — check the failed file, fix or request a corrected export from the client","default_assignee":"Luca"}'::jsonb
)
ON CONFLICT (catalog_id, slug) DO NOTHING;
