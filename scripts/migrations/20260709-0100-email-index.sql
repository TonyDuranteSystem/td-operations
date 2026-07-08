-- EMAIL INDEX (dev_task 224726be) — leg 1: the data layer.
--
-- Metadata-only, REBUILDABLE cache of Gmail (both mailboxes): one row per
-- message — NO bodies, NO attachments. Gmail stays the single source of
-- truth for content/labels; on drift, wipe and rebuild. Fed by (a) a
-- resumable backfill cron and (b) the shipped gmail-push pipeline
-- (historyId → incremental). Powers instant any-age search + client email
-- timelines without live Gmail round-trips.

CREATE TABLE IF NOT EXISTS email_index (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox text NOT NULL,                       -- 'support' | 'antonio'
  thread_id text NOT NULL,
  message_id text NOT NULL,
  from_email text,
  from_name text,
  to_emails text[] NOT NULL DEFAULT '{}',      -- lowercased bare addresses
  subject text,
  snippet text,                                -- entity-decoded display snippet
  internal_date timestamptz,
  is_unread boolean NOT NULL DEFAULT false,
  has_attachment boolean NOT NULL DEFAULT false,
  -- Resolved CRM linkage (best-effort; thread-level email_links override
  -- is applied at query time)
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(subject, '') || ' ' || coalesce(from_name, '') || ' ' ||
      coalesce(from_email, '') || ' ' || coalesce(snippet, ''))
  ) STORED,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox, message_id)
);

COMMENT ON TABLE email_index IS
  'Metadata-only rebuildable Gmail index (no bodies/attachments). Fed by email-index backfill cron + gmail-push incremental sync (lib/email-index/sync.ts). Gmail is the source of truth — safe to wipe and rebuild. antonio@ rows are admin-only via RLS.';

CREATE INDEX IF NOT EXISTS idx_email_index_thread ON email_index (mailbox, thread_id);
CREATE INDEX IF NOT EXISTS idx_email_index_date ON email_index (internal_date DESC);
CREATE INDEX IF NOT EXISTS idx_email_index_account ON email_index (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_index_contact ON email_index (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_index_unread ON email_index (mailbox) WHERE is_unread;
CREATE INDEX IF NOT EXISTS idx_email_index_search ON email_index USING GIN (search);

-- RLS: staff read; antonio@ rows ADMIN-ONLY (mirrors checkMailboxAccess).
-- All writes are service-role (sync engine).
ALTER TABLE email_index ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_index_staff_select ON email_index;
CREATE POLICY email_index_staff_select ON email_index
  FOR SELECT TO authenticated
  USING (
    coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') NOT IN ('client', 'partner')
    AND (
      mailbox <> 'antonio'
      OR coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
    )
  );

-- Sync-state columns on the existing per-mailbox watch table
ALTER TABLE gmail_watch_state ADD COLUMN IF NOT EXISTS index_history_id text;
ALTER TABLE gmail_watch_state ADD COLUMN IF NOT EXISTS backfill_page_token text;
ALTER TABLE gmail_watch_state ADD COLUMN IF NOT EXISTS backfill_done boolean NOT NULL DEFAULT false;
