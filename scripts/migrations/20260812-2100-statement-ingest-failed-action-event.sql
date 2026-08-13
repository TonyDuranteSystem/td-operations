-- Card 4a39e0fd (Antonio's binding ruling 2026-08-12): a failed statement
-- ingest must raise a staff What's New card, not just a passive failed-jobs
-- row. Scope is "account" — statements belong to the company's books.
--
-- Wording rule (Antonio, 2026-08-12): the Exception Center is REJECTED as a
-- staff surface — staff work in the client's own workspace. The next_step
-- therefore points at the client's financials review, never at an admin page.
-- ON CONFLICT DO UPDATE so re-running this script corrects any earlier copy
-- of the row that carried the old Exception-Center wording (sandbox did).
INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata)
VALUES (
  'action_events',
  'statement_ingest_failed',
  'Bank statement could not be read',
  'active',
  '{"scope":"account","next_step":"Open the client''s financials review — the failed file card names the file and the fix; remove it or request a corrected export from the client","default_assignee":"Luca"}'::jsonb
)
ON CONFLICT (catalog_id, slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  status = EXCLUDED.status,
  metadata = EXCLUDED.metadata;
