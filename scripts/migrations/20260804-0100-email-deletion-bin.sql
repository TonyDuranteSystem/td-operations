-- EMAIL DELETION MIRROR + 180-DAY BIN (Antonio 2026-08-02/04, dev_task 01800da8).
--
-- Decided model, in Antonio's words: "If we delete an email in our inbox, Gmail
-- must be cleaned up as well, and we always have to have the option to go in the
-- bin and recover an email that maybe mistakenly was deleted." Retention: 180 days.
--
-- Deleting in the CRM ALREADY moves the thread to Gmail's Trash and restore
-- already works — that half needed nothing. What was missing is our own copy:
-- it kept every captured body/attachment forever with no notion of deletion.
--
-- `deleted_at` = when we first observed the message gone from the live mailbox
-- (Gmail TRASH, or absent entirely). It is the bin clock:
--   * 0–180 days  → our copy is RETAINED and readable. Note Gmail itself purges
--                   its Trash at ~30 days, so from day ~30 our copy is the ONLY
--                   copy — which is exactly the point of keeping it.
--   * after 180d  → purged by the sweep (row + stored objects).
-- "Delete forever" sets it to the epoch so the next sweep purges immediately.
--
-- Nullable + no default: a NULL means "still live", so every existing row is
-- untouched and nothing is retro-marked as deleted.

ALTER TABLE email_message_content
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMENT ON COLUMN email_message_content.deleted_at IS
  'When this message was first observed deleted from the live mailbox (Gmail TRASH or absent). NULL = live. Starts the 180-day bin clock; the purge sweep removes the row + its storage objects after that. Set to epoch by "delete forever" to purge on the next sweep. dev_task 01800da8.';

-- The sweep asks "what is past its bin window?" — a partial index keeps that a
-- cheap lookup as the store grows, and costs nothing for live rows.
CREATE INDEX IF NOT EXISTS idx_email_content_deleted_at
  ON email_message_content (deleted_at)
  WHERE deleted_at IS NOT NULL;
