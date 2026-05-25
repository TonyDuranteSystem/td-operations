-- migration:20260524-1100-seed-help-content.sql
--
-- Contextual Help "i" system (Slice 1). A catalog of help blurbs keyed by a
-- stable help_key (slug = area.element). Each <HelpDot helpKey="..."> looks up
-- its entry and shows three short lines: what it does / what happens on click /
-- what's next. Staff-only, owner-editable via the Help settings page (no deploy).
--
-- admin_can_add_rows = true so Antonio can add new keys himself.
-- metadata: { what, on_click, next, area, order } (all strings; order numeric).
--
-- Starter content covers the Notification Center board so the feature is usable
-- immediately; expand area-by-area later. See sysdoc help-system-plan. Idempotent.

INSERT INTO catalog_definitions (id, display_name, description, admin_can_add_rows) VALUES
  ('help_content','Help content','Inline help shown by the little "i" buttons across the CRM. Each entry = one control; edit what it does / what happens on click / what''s next.', true)
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name, description = EXCLUDED.description, updated_at = now();

INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata) VALUES
  ('help_content','board.snooze','Snooze a card','active','{"area":"Notification Center","order":10,"what":"Hides this to-do until a date you choose.","on_click":"Pick a future date — the card leaves the board (and stops counting) until then.","next":"On that date it reappears automatically. Use this for cards waiting on the IRS or the client."}'::jsonb),
  ('help_content','board.reminder','Reminder date','active','{"area":"Notification Center","order":20,"what":"A \"do this by\" date. It colours the card but does NOT hide it.","on_click":"Pick a date — the card turns amber when due and red when overdue, and floats up.","next":"If you want the card hidden until later instead, use Snooze."}'::jsonb),
  ('help_content','board.done','Mark done','active','{"area":"Notification Center","order":30,"what":"Closes this to-do.","on_click":"Moves the card to the Done column and removes it from the board.","next":"It stops counting toward the total — nothing else to do."}'::jsonb),
  ('help_content','board.move','Move between columns','active','{"area":"Notification Center","order":40,"what":"Moves the card across your stages.","on_click":"Pick a column (Action needed, In progress, Waiting on client, Wait for the IRS). Choosing the Done column closes the card.","next":"The card moves there for everyone on the team."}'::jsonb),
  ('help_content','card.service','Create service','active','{"area":"Notification Center","order":50,"what":"Starts a new service for this client.","on_click":"Opens a small form to pick the service type, then creates it (and a draft invoice if that service has a set price).","next":"The new service shows in the client''s pipeline; work it from there."}'::jsonb),
  ('help_content','card.invoice','Create invoice','active','{"area":"Notification Center","order":60,"what":"Creates an invoice for this client (a company, or an individual via New Customer).","on_click":"Opens the invoice form pre-filled for the client. Save as Draft to review, or Create & Send to deliver it.","next":"A sent invoice appears in the client''s portal to pay (or an email with card + wire details if they have no portal)."}'::jsonb),
  ('help_content','board.new_card','New card','active','{"area":"Notification Center","order":70,"what":"Adds a to-do by hand (not from a client action).","on_click":"Opens a form to pick the client, write what to do, and choose a column.","next":"The card appears on the board and the client''s activity widget."}'::jsonb),
  ('help_content','board.settings','Board settings','active','{"area":"Notification Center","order":80,"what":"Customise the board without a developer.","on_click":"Opens settings to rename/add columns, edit the card wording, and choose which client events show in What''s New.","next":"Changes apply instantly for the whole team."}'::jsonb)
ON CONFLICT (catalog_id, slug) DO UPDATE
  SET display_name = EXCLUDED.display_name, status = 'active',
      metadata = EXCLUDED.metadata, updated_at = now();
