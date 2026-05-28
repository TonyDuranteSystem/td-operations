-- Portal Chat pinning (2026-05-28)
-- Two independent pin features:
--   1) Pinned MESSAGES — shared, visible to BOTH staff and client. Either side
--      can pin/unpin a message in a conversation; it surfaces in a "Pinned" strip
--      at the top of the chat. No limit. Stored on the message row.
--   2) Pinned CONVERSATIONS — STAFF-ONLY (clients have a single conversation, no
--      list). Shared across the team (one row per thread). Pinned threads sort
--      above everything in the CRM Portal Chats list.

-- ── 1) Pinned messages ───────────────────────────────────────────────────────
ALTER TABLE portal_messages
  ADD COLUMN IF NOT EXISTS pinned_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pinned_by      UUID,
  ADD COLUMN IF NOT EXISTS pinned_by_type TEXT;   -- 'client' | 'staff'

-- Fetch pinned messages per thread quickly (account- or contact-scoped),
-- excluding soft-deleted rows (R100).
CREATE INDEX IF NOT EXISTS idx_portal_messages_pinned_account
  ON portal_messages (account_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_portal_messages_pinned_contact
  ON portal_messages (contact_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL AND deleted_at IS NULL;

-- ── 2) Pinned conversations (staff, shared) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS portal_chat_pinned_threads (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  pinned_by  UUID,
  pinned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT portal_chat_pinned_threads_target_chk
    CHECK (account_id IS NOT NULL OR contact_id IS NOT NULL)
);

-- A thread can be pinned once (shared across staff): unique per target.
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_chat_pinned_account
  ON portal_chat_pinned_threads (account_id) WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_chat_pinned_contact
  ON portal_chat_pinned_threads (contact_id) WHERE contact_id IS NOT NULL;
