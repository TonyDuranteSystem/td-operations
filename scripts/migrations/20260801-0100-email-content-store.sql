-- OWN-INBOX (dev_task 01800da8) — leg 1: the content store.
--
-- Extends the metadata-only email_index with a FULL local copy of every email:
-- raw MIME + every attachment's bytes in a PRIVATE bucket, plus a per-message
-- capture ledger. Goal: the CRM inbox reads/searches/serves attachments from
-- US, never live Gmail. Google Workspace stays the mailbox for send/receive.
--
-- Council review 2026-08-01 (FIX-FIRST) shaped this schema. The invariants it
-- demanded are encoded here:
--  * COMPOSITE (mailbox, message_id) keys everywhere — a Gmail message_id is
--    unique only WITHIN one Google account, and we mirror two (support@,
--    antonio@). Keying on message_id alone would collide/serve the wrong body.
--  * A per-message capture ledger with an explicit completeness flag
--    (capture_status='complete') written LAST — so "local-first" reads only
--    trust a message we can PROVE is fully stored; anything else falls back to
--    live Gmail. This is what makes the store safe to READ from, unlike the
--    rebuildable metadata cache.
--  * SEPARATE backfill cursor columns (content_*), never overloading the
--    metadata backfill_done flag.
--  * NO inline GENERATED tsvector over the body (a >1MB lexeme payload aborts
--    the INSERT). Full-text search is a later leg; body_text is captured now,
--    the search index is built then.
--  * The rendered HTML body lives as a storage OBJECT (body_path), not a DB
--    column, keeping rows small. Capture uses ONE Gmail get (format:full) per
--    message (council 2026-08-01 throughput review: a second format:raw get was
--    a 2x quota tax); Gmail stays the re-fetchable source of truth.

-- ── Private bucket: raw MIME + attachment bytes ──────────────────────────────
-- Mirrors the worker-attachments pattern: public=false, NO RLS policies added on
-- purpose. storage.objects denies by default and the service role bypasses RLS,
-- so ONLY server-side code reads these objects. A client or a leaked anon key
-- gets nothing. Bytes are served to staff via short-lived signed URLs minted by
-- a server route that re-checks mailbox access first. 30 MB ceiling (Gmail's own
-- attachment cap is 25 MB).
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('email-content', 'email-content', false, 31457280)
ON CONFLICT (id) DO NOTHING;

-- ── Per-message capture ledger + body pointer ────────────────────────────────
CREATE TABLE IF NOT EXISTS email_message_content (
  mailbox text NOT NULL,                        -- 'support' | 'antonio'
  message_id text NOT NULL,
  thread_id text NOT NULL,
  body_path text,                               -- storage path to the rendered HTML body (from format:full)
  body_text text,                               -- extracted plain text (for later FTS)
  has_attachments boolean NOT NULL DEFAULT false,
  attachment_count integer NOT NULL DEFAULT 0,
  -- completeness ledger — 'complete' is written LAST, only after raw MIME and
  -- EVERY attachment object are confirmed in the bucket. local-first reads MUST
  -- fall back to live Gmail unless status='complete'.
  capture_status text NOT NULL DEFAULT 'pending'
    CHECK (capture_status IN ('pending', 'complete', 'error')),
  capture_error text,
  captured_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox, message_id),
  FOREIGN KEY (mailbox, message_id)
    REFERENCES email_index (mailbox, message_id) ON DELETE CASCADE
);

COMMENT ON TABLE email_message_content IS
  'Own-Inbox content ledger: raw MIME pointer + capture completeness per message. capture_status=complete (written last) is the gate local-first reads trust; else fall back to live Gmail. Composite (mailbox, message_id) — message_id is per-Google-account. dev_task 01800da8.';

CREATE INDEX IF NOT EXISTS idx_email_content_thread
  ON email_message_content (mailbox, thread_id);
CREATE INDEX IF NOT EXISTS idx_email_content_incomplete
  ON email_message_content (mailbox) WHERE capture_status <> 'complete';

-- ── One row per attachment (metadata; bytes live in the bucket) ──────────────
CREATE TABLE IF NOT EXISTS email_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox text NOT NULL,
  message_id text NOT NULL,
  thread_id text NOT NULL,
  gmail_attachment_id text NOT NULL,            -- Gmail's per-message attachment id
  filename text,                                -- sender-supplied DISPLAY name (data, never used in path)
  mime_type text,
  size_bytes bigint,
  storage_path text NOT NULL,                   -- OPAQUE path (hashed id) — never sender filename
  is_inline boolean NOT NULL DEFAULT false,
  content_id text,                              -- cid: reference for inline images
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox, message_id, gmail_attachment_id),
  FOREIGN KEY (mailbox, message_id)
    REFERENCES email_index (mailbox, message_id) ON DELETE CASCADE
);

COMMENT ON TABLE email_attachment IS
  'Own-Inbox attachment metadata; bytes in private email-content bucket at opaque storage_path (never the sender filename → no path traversal). Composite (mailbox, message_id) FK to email_index. dev_task 01800da8.';

CREATE INDEX IF NOT EXISTS idx_email_attachment_msg
  ON email_attachment (mailbox, message_id);

-- ── RLS: staff read; antonio@ rows ADMIN-ONLY (mirrors email_index exactly) ──
-- All writes are service-role (capture engine). Reads are re-gated in the app by
-- checkMailboxAccess before any signed URL is minted; RLS is defense-in-depth.
ALTER TABLE email_message_content ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_content_staff_select ON email_message_content;
CREATE POLICY email_content_staff_select ON email_message_content
  FOR SELECT TO authenticated
  USING (
    coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') NOT IN ('client', 'partner')
    AND (mailbox <> 'antonio'
         OR coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin')
  );

ALTER TABLE email_attachment ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_attachment_staff_select ON email_attachment;
CREATE POLICY email_attachment_staff_select ON email_attachment
  FOR SELECT TO authenticated
  USING (
    coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') NOT IN ('client', 'partner')
    AND (mailbox <> 'antonio'
         OR coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin')
  );

-- ── Separate content-backfill cursor (NEVER overload metadata backfill_done) ──
ALTER TABLE gmail_watch_state ADD COLUMN IF NOT EXISTS content_backfill_page_token text;
ALTER TABLE gmail_watch_state ADD COLUMN IF NOT EXISTS content_backfill_done boolean NOT NULL DEFAULT false;
