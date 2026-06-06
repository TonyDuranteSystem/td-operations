-- Client-side "Mark as Unread" for portal chat messages.
--
-- Adds a flag the client can set on an admin message so it keeps counting
-- toward their unread badge even after it's been read.
--
-- REPLICA IDENTITY FULL is required so the portal sidebar's realtime UPDATE
-- listener receives the OLD value of client_kept_unread in the change payload.
-- With the default replica identity only the primary key ships in payload.old,
-- so the listener could not tell whether the flag actually flipped (vs any
-- other column changing — read_at, pin, edit) and would miscount the badge.
ALTER TABLE portal_messages ADD COLUMN client_kept_unread BOOLEAN DEFAULT FALSE;
ALTER TABLE portal_messages REPLICA IDENTITY FULL;
