-- migration:20260524-1800-help-content-portal-chats-2.sql
--
-- Help content (Slice 3) — Portal Chats, part 2: the left-panel tabs and the
-- per-conversation Topics. Authored by Claude from the implementation. Idempotent.

INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata) VALUES
  ('help_content','chat.page_tabs','Chats · Actions · Team','active','{"area":"Portal Chats","order":5,"what":"The three lists in this panel: Chats (your client conversations), Actions (every open To-Do card across ALL clients — the dashboard board shown as a list), and Team (internal staff discussions, never visible to clients).","on_click":"","next":"Chats and Team show unread badges so you see what needs a reply. Actions mirrors the dashboard To-Do board."}'::jsonb),
  ('help_content','chat.topics','Topics','active','{"area":"Portal Chats","order":40,"what":"Split a client''s chat into subjects (e.g. Formation, Tax, Banking) so a long conversation stays organised. The \"Topic\" chip shows untagged messages; each other chip is one topic with its own unread count.","on_click":"","next":"Click a topic to filter the chat to it; \"Create a new topic\" starts one. A message you send goes to whichever topic you''re viewing."}'::jsonb)
ON CONFLICT (catalog_id, slug) DO UPDATE
  SET display_name = EXCLUDED.display_name, status = 'active',
      metadata = EXCLUDED.metadata, updated_at = now();
