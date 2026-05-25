-- migration:20260524-1400-help-content-feature-overviews.sql
--
-- Help content (Slice 3) — FEATURE-LEVEL explainers (the workflow behind a whole
-- area), placed on roomy section headers. Authored by Claude from the actual
-- implementation; Antonio edits only if unclear. on_click left blank for overview
-- entries (HelpDot only renders sections that have text). Idempotent.

INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata) VALUES
  ('help_content','board.overview','The To-Do board','active','{"area":"Notification Center","order":5,"what":"A staff-only shared to-do list, built automatically from what clients do (pay, sign, submit) plus cards you add by hand. Each card is one thing to handle, for a person or a company, and moves through your columns: Action needed → In progress → Waiting on client → Wait for the IRS → Done.","on_click":"","next":"On each card: move it with the dropdown or drag it; set a Reminder (colours it when due) or Snooze it (hides it until a date); mark Done to close it. Cards also appear on the client''s page and feed the purple per-client dot in Portal Chats."}'::jsonb),
  ('help_content','widget.activity','Activity & to-dos (on a client page)','active','{"area":"Client pages","order":10,"what":"Everything happening for this one client in a single panel: What''s New (things the client just did), their open To-Dos, and any live Workflow steps — so you do not have to dig through tabs.","on_click":"","next":"Use \"Open in chat\" to jump straight to this client''s Portal Chats thread, where you can act on each item (reply, snooze, create a service or invoice)."}'::jsonb)
ON CONFLICT (catalog_id, slug) DO UPDATE
  SET display_name = EXCLUDED.display_name, status = 'active',
      metadata = EXCLUDED.metadata, updated_at = now();
