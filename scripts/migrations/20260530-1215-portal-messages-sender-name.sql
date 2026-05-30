-- Portal Team Access — add sender_name to portal_messages.
-- A teammate (portal_team_members) has no contact, so their chat messages can't
-- resolve a display name via the contact join. The chat route stamps the
-- teammate's display name onto sender_name at send time; the read route surfaces
-- it (pickChatSenderName). Without this column the teammate INSERT fails with
-- "Could not find the 'sender_name' column" (PGRST204) — teammate chat send 500s.
-- Additive + nullable: NULL for normal client/admin messages (name resolves via
-- the contact join or the generic "Tony Durante Team" label). No backfill.
ALTER TABLE portal_messages ADD COLUMN IF NOT EXISTS sender_name text;

COMMENT ON COLUMN portal_messages.sender_name IS
  'Display name stamped at send for senders without a contact (Portal Team Access teammates). NULL for normal client/admin messages (name resolves via contact join / generic team label).';
