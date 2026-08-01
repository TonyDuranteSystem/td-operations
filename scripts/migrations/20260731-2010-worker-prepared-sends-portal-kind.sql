-- Inbox worker: a PORTAL CHAT message can now be frozen for Confirm, alongside email.
-- Dev job d2024649. Antonio, 2026-07-31: "the worker must send the message with the card
-- that we already built in Inbox … we want the same thing" — plus a client picker and an
-- English/Italian control ON the card.
--
-- DESIGN NOTES THAT THE REVIEW FORCED (Bug-Hunter + Senior-Engineer, 2026-07-31):
--
-- 1. `kind` is NOT NULL with **NO DEFAULT**, deliberately. A default of 'email' fails toward
--    SENDING AN EMAIL: any insert that forgets the discriminator would be dispatched by
--    confirmWorkerEmailSend as Gmail. With no default, a forgetful insert raises instead.
--
-- 2. The email-only columns become NULLABLE, but a per-kind CHECK makes the shape exact:
--      kind='email'  → mailbox / to_address / subject are all NOT NULL   (unchanged in practice)
--      kind='portal' → mailbox / to_address / subject are all NULL       (enforced)
--    A portal row therefore CANNOT physically carry an email address or a mailbox, so the
--    "portal row dispatched down the Gmail path" failure the reviewers traced is impossible
--    at the database level, not merely avoided by a branch. `body` stays NOT NULL — both
--    kinds carry a body.
--
-- 3. Recipient columns are split PROPOSED vs CONFIRMED, on purpose:
--      proposed_* — what the worker suggested at freeze time (may be NULL; the Inbox has no
--                   pinned client). Pre-fills the picker. NEVER authoritative.
--      portal_*   — what the human actually picked, written at claim time by the confirm
--                   endpoint after re-validation. This is the audit record of who was messaged.
--    Keeping them apart means a proposal can never be mistaken for an authorisation.
--
-- 4. `draft_locale` freezes the language the message was DETECTED to be written in, so the
--    confirm step can refuse a mismatch against the client the human picked. Antonio,
--    2026-07-31: "If the client speaks English, the message must be in English. If the client
--    speaks Italian, the message must be in Italian." The card shows the language; this column
--    is what lets the SERVER enforce it rather than trusting a label.
--    'unknown' is a real value: the detector fails open on short/mixed text by design.

ALTER TABLE worker_prepared_sends
  ADD COLUMN IF NOT EXISTS kind                text,
  ADD COLUMN IF NOT EXISTS proposed_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proposed_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS portal_account_id   uuid REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS portal_contact_id   uuid REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS draft_locale        text;

-- Every existing row predates portal sends.
UPDATE worker_prepared_sends SET kind = 'email' WHERE kind IS NULL;

-- ⚠️ `kind` IS DELIBERATELY LEFT NULLABLE BY THIS FILE. The SET NOT NULL lives in
-- 20260731-2150-prepared-send-kind-not-null.sql and must run only AFTER the code
-- that always writes `kind` is deployed.
--
-- Why: the currently-deployed email freeze (`prepareWorkerEmailSend`,
-- lib/inbox/worker-email-send.ts) does not write `kind`. Making the column NOT NULL
-- while that code is live makes EVERY Inbox email freeze fail with a not-null
-- violation — supabase-js returns it, the helper turns it into "❌ Couldn't prepare
-- the email — please try again", and nobody can send an email from the worker on any
-- surface until the deploy lands. Caught by the Bug-Hunter before it shipped.
--
-- A CHECK constraint does NOT have this problem: NULL passes a CHECK, so the
-- vocabulary constraint below is safe to apply ahead of the code.
--
-- PRODUCTION ORDER: (1) this file → (2) deploy the code → (3) the 2150 file.

-- Email columns are email-only from here on.
ALTER TABLE worker_prepared_sends ALTER COLUMN mailbox    DROP NOT NULL;
ALTER TABLE worker_prepared_sends ALTER COLUMN to_address DROP NOT NULL;
ALTER TABLE worker_prepared_sends ALTER COLUMN subject    DROP NOT NULL;

DO $$
BEGIN
  -- conrelid-scoped on purpose: constraint names are unique PER RELATION, not globally.
  -- An unscoped name test can match something on another table, silently skip the ADD,
  -- and leave a database that looks migrated and is not — which is how "verified in
  -- sandbox" stops meaning anything. (Bug-Hunter, 2026-07-31.)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'worker_prepared_sends'::regclass AND conname ='worker_prepared_sends_kind_check') THEN
    ALTER TABLE worker_prepared_sends
      ADD CONSTRAINT worker_prepared_sends_kind_check CHECK (kind IN ('email','portal'));
  END IF;

  -- conrelid-scoped on purpose: constraint names are unique PER RELATION, not globally.
  -- An unscoped name test can match something on another table, silently skip the ADD,
  -- and leave a database that looks migrated and is not — which is how "verified in
  -- sandbox" stops meaning anything. (Bug-Hunter, 2026-07-31.)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'worker_prepared_sends'::regclass AND conname ='worker_prepared_sends_draft_locale_check') THEN
    ALTER TABLE worker_prepared_sends
      ADD CONSTRAINT worker_prepared_sends_draft_locale_check
      CHECK (draft_locale IS NULL OR draft_locale IN ('en','it','unknown'));
  END IF;

  -- The shape rule: an email row is fully email-shaped, a portal row carries no email fields.
  -- conrelid-scoped on purpose: constraint names are unique PER RELATION, not globally.
  -- An unscoped name test can match something on another table, silently skip the ADD,
  -- and leave a database that looks migrated and is not — which is how "verified in
  -- sandbox" stops meaning anything. (Bug-Hunter, 2026-07-31.)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'worker_prepared_sends'::regclass AND conname ='worker_prepared_sends_kind_shape') THEN
    ALTER TABLE worker_prepared_sends
      ADD CONSTRAINT worker_prepared_sends_kind_shape CHECK (
        (kind = 'email'  AND mailbox IS NOT NULL AND to_address IS NOT NULL AND subject IS NOT NULL)
        OR
        (kind = 'portal' AND mailbox IS NULL     AND to_address IS NULL     AND subject IS NULL)
      );
  END IF;
END $$;

-- The panel polls for this actor's pending rows; kind is read on every one of them.
CREATE INDEX IF NOT EXISTS idx_worker_prepared_sends_thread_actor_pending
  ON worker_prepared_sends (thread_uuid, actor, created_at)
  WHERE status = 'pending';

COMMENT ON COLUMN worker_prepared_sends.kind IS
  'email | portal. NO DEFAULT on purpose — a default of email would make a forgetful insert send a real email.';
COMMENT ON COLUMN worker_prepared_sends.proposed_account_id IS
  'The client the WORKER suggested at freeze time. Pre-fills the Confirm card picker. Never authoritative.';
COMMENT ON COLUMN worker_prepared_sends.portal_account_id IS
  'The client the HUMAN actually confirmed, written at claim time after server re-validation. The audit record.';
COMMENT ON COLUMN worker_prepared_sends.draft_locale IS
  'en | it | unknown — the language the frozen message was detected to be in, so confirm can refuse a mismatch against the picked client.';
