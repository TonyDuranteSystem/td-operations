-- EMAIL INDEX leg 2 — store Gmail label IDs per message.
--
-- Without labels the index cannot distinguish trashed/archived mail
-- (client email cards would resurface deleted threads), cannot scope the
-- green dot to in:inbox parity, cannot detect drafts, and cannot resolve
-- the Marked/* color labels. label_ids is the raw Gmail labelIds array.
--
-- The index is a REBUILDABLE CACHE (leg 1 design): rows already written
-- lack labels, so we wipe and let the resumable backfill re-run. While
-- backfill_done=false every leg-2 surface falls back to live Gmail.

ALTER TABLE email_index ADD COLUMN IF NOT EXISTS label_ids text[] NOT NULL DEFAULT '{}';

-- Green-dot query: unread threads still in the inbox
CREATE INDEX IF NOT EXISTS idx_email_index_unread_inbox
  ON email_index (mailbox)
  WHERE label_ids @> '{UNREAD}' AND label_ids @> '{INBOX}';

-- Wipe + restart the backfill so every row carries labels
TRUNCATE email_index;
UPDATE gmail_watch_state
SET backfill_done = false,
    backfill_page_token = NULL,
    updated_at = now();
