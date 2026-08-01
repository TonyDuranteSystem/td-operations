-- ============================================================================
-- PRODUCTION — RUN THIS ONE NOW. Safe to run while the current code is live.
-- Dev job d2024649 (Inbox worker: send a portal chat message behind a Confirm card).
-- Approved by Antonio 2026-07-31.
--
-- This is migrations 20260731-2010 + 20260731-2140 folded together (2140 only
-- narrowed draft_locale from ('en','it','unknown') to ('en','it'); the narrowed
-- form is what appears below, so running this once is equivalent to running both).
--
-- WHY IT IS SAFE AHEAD OF THE DEPLOY:
--   • Every new column is nullable.
--   • `kind` is left NULLABLE here on purpose. The email freeze running in production
--     right now does not write it. A NULL value passes every CHECK below — including
--     the shape rule, whose two branches both evaluate to NULL when kind is NULL, and
--     a CHECK only fails on FALSE. So existing behaviour is untouched.
--   • Dropping NOT NULL from mailbox/to_address/subject only widens what is accepted.
--
-- WHAT MUST NOT BE RUN YET:
--   scripts/migrations/20260731-2150-prepared-send-kind-not-null.sql
--   That one makes `kind` compulsory and must run only AFTER the new code is deployed,
--   or every worker email freeze fails on all four surfaces until the deploy lands.
--   It guards itself: run early and it raises a plain error instead of causing damage.
--
-- ORDER:  this file  →  deploy the code  →  the 2150 file.
-- ============================================================================

ALTER TABLE worker_prepared_sends
  ADD COLUMN IF NOT EXISTS kind                text,
  ADD COLUMN IF NOT EXISTS proposed_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proposed_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS portal_account_id   uuid REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS portal_contact_id   uuid REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS draft_locale        text;

-- Every existing row predates portal sends.
UPDATE worker_prepared_sends SET kind = 'email' WHERE kind IS NULL;

-- Email-only columns become email-only.
ALTER TABLE worker_prepared_sends ALTER COLUMN mailbox    DROP NOT NULL;
ALTER TABLE worker_prepared_sends ALTER COLUMN to_address DROP NOT NULL;
ALTER TABLE worker_prepared_sends ALTER COLUMN subject    DROP NOT NULL;

DO $$
BEGIN
  -- conrelid-scoped: constraint names are unique per relation, not globally. An
  -- unscoped name test can match another table's constraint, silently skip the ADD,
  -- and leave a database that looks migrated and is not.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'worker_prepared_sends'::regclass AND conname = 'worker_prepared_sends_kind_check') THEN
    ALTER TABLE worker_prepared_sends
      ADD CONSTRAINT worker_prepared_sends_kind_check CHECK (kind IN ('email','portal'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'worker_prepared_sends'::regclass AND conname = 'worker_prepared_sends_draft_locale_check') THEN
    ALTER TABLE worker_prepared_sends
      ADD CONSTRAINT worker_prepared_sends_draft_locale_check
      CHECK (draft_locale IS NULL OR draft_locale IN ('en','it'));
  END IF;

  -- An email row is fully email-shaped; a PORTAL row carries no email fields at all.
  -- This is what makes "a portal message dispatched down the Gmail path" impossible at
  -- the storage layer rather than at a branch someone can reorder.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'worker_prepared_sends'::regclass AND conname = 'worker_prepared_sends_kind_shape') THEN
    ALTER TABLE worker_prepared_sends
      ADD CONSTRAINT worker_prepared_sends_kind_shape CHECK (
        (kind = 'email'  AND mailbox IS NOT NULL AND to_address IS NOT NULL AND subject IS NOT NULL)
        OR
        (kind = 'portal' AND mailbox IS NULL     AND to_address IS NULL     AND subject IS NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_worker_prepared_sends_thread_actor_pending
  ON worker_prepared_sends (thread_uuid, actor, created_at)
  WHERE status = 'pending';

COMMENT ON COLUMN worker_prepared_sends.kind IS
  'email | portal. Becomes NOT NULL only after the code that always writes it is deployed.';
COMMENT ON COLUMN worker_prepared_sends.proposed_account_id IS
  'The client the WORKER suggested at freeze time. Pre-fills nothing by itself. Never authoritative.';
COMMENT ON COLUMN worker_prepared_sends.portal_account_id IS
  'The client the HUMAN confirmed, written at claim time after server re-validation. The audit record.';
COMMENT ON COLUMN worker_prepared_sends.draft_locale IS
  'en | it — the language the staff member CHOSE on the Confirm card, carried as an instruction to the worker. Never a detector verdict.';
