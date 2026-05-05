-- PR 2 Step 6 — tagged chat
--
-- Adds sender_context column to portal_messages so each message can be
-- tagged "person" or "company" by the sender. Per Antonio's architectural
-- model (sysdoc ops-2026-05-03-formation-architecture-decision-and-plan,
-- Quote 4): one tagged thread per contact, each message labeled with
-- which scope the sender chose.
--
-- Antonio's design decision 2026-05-05: legacy messages stay unlabeled
-- (column nullable, no backfill). Only new messages get tagged. Existing
-- messages render without a badge.
--
-- TEXT + CHECK chosen over a Postgres ENUM type for ease of future
-- extension (ENUMs require ALTER TYPE ADD VALUE which has restricted
-- transactional semantics).

ALTER TABLE portal_messages
  ADD COLUMN IF NOT EXISTS sender_context TEXT;

ALTER TABLE portal_messages
  DROP CONSTRAINT IF EXISTS portal_messages_sender_context_check;

ALTER TABLE portal_messages
  ADD CONSTRAINT portal_messages_sender_context_check
  CHECK (sender_context IS NULL OR sender_context IN ('person', 'company'));

COMMENT ON COLUMN portal_messages.sender_context IS
  'PR 2 Step 6 (2026-05-05). Tag chosen by sender: person | company. NULL = legacy untagged message (pre-PR 2). Person = sent as the individual; Company = sent in the context of the linked account_id.';
