-- Portal Chats: "Waiting for client" mark (2026-11-21, dev job 954af5db)
-- Staff mark a whole CONVERSATION as "waiting for the client to answer". Shared by all staff,
-- one row per conversation (same shape as portal_chat_pinned_threads: keyed by company OR by person).
-- The mark ends by itself the moment the client writes after `marked_at` (decided at read time from
-- portal_messages, so no write is needed on every client message), or staff clear it by hand (row deleted).
-- `reminders_sent` / `last_reminder_at` are the automatic-reminder bookkeeping (3 days apart, at most 2).

CREATE TABLE IF NOT EXISTS portal_chat_waiting_threads (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id       UUID REFERENCES contacts(id) ON DELETE CASCADE,
  marked_by        UUID,
  marked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  reminders_sent   INTEGER NOT NULL DEFAULT 0,
  last_reminder_at TIMESTAMPTZ,
  CONSTRAINT portal_chat_waiting_threads_target_chk
    CHECK (account_id IS NOT NULL OR contact_id IS NOT NULL)
);

-- One mark per conversation (shared across staff).
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_chat_waiting_account
  ON portal_chat_waiting_threads (account_id) WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_chat_waiting_contact
  ON portal_chat_waiting_threads (contact_id) WHERE contact_id IS NOT NULL;

-- Server-only table (service role): RLS on with no policies, and no privileges for the browser roles (the standing lock rule,
-- tests/unit/migrations-marketing-lock.test.ts + migrations-booking-lock.test.ts).
ALTER TABLE public.portal_chat_waiting_threads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portal_chat_waiting_threads FROM anon, authenticated;

SELECT public.marketing_lock_all_tables();
