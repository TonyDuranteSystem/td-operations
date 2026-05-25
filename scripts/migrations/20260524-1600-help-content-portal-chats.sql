-- migration:20260524-1600-help-content-portal-chats.sql
--
-- Help content (Slice 3) — Portal Chats area. Authored by Claude from the actual
-- implementation. Feature/workflow-level explainers on the thread views + the two
-- staff panels. on_click blank for overviews (HelpDot only renders filled sections).
-- Idempotent.

INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata) VALUES
  ('help_content','chat.tabs','Messages · What''s New · To Do','active','{"area":"Portal Chats","order":10,"what":"Three views of the same client: Messages (the actual chat with them), What''s New (things they just did, for you to triage), and To Do (your team''s tasks for them).","on_click":"","next":"Switch tabs anytime. The What''s New count is what drives the purple dot next to the client in the thread list."}'::jsonb),
  ('help_content','whatsnew.feed','What''s New — things this client did','active','{"area":"Portal Chats","order":20,"what":"The things THIS client just did — payments, signatures, form submissions — that the team needs to handle. It only shows the event types turned ON in Board Settings → What''s New (so you control the noise).","on_click":"","next":"Tick Handled once you have dealt with one (it drops off the purple dot), or Open card to turn it into a To-Do. Items that came from a workflow show that workflow''s own action buttons right here."}'::jsonb),
  ('help_content','todo.panel','To-Do (for this client)','active','{"area":"Portal Chats","order":30,"what":"The open to-do cards for this client — the SAME cards as the dashboard To-Do board. Anything you add here also appears there and on the client''s page.","on_click":"","next":"Add a to-do, set a reminder or priority, Snooze it, or mark it Done — same controls as the board. You can also create a service or an invoice straight from a card."}'::jsonb)
ON CONFLICT (catalog_id, slug) DO UPDATE
  SET display_name = EXCLUDED.display_name, status = 'active',
      metadata = EXCLUDED.metadata, updated_at = now();
