-- TD Marketing: the team's own chat — direct messages and groups (dev job 9aec66fa, round 2 step 3) — and @mentions.
-- Marketing-only copies of the shapes the lead chat uses, so this chat never touches the CRM's chat tables or the live lead chat's data.
-- Files and voice notes go in the SAME private bucket as the lead chat (marketing-chat), under <team_id>/<thread_id>/.
-- Requires 20261023-2000-marketing-lead-chat.sql (the bucket and the lock) and 20261017-1900-marketing-p0-settings.sql (marketing_teams).
DO $$
BEGIN
  IF to_regclass('public.marketing_lead_messages') IS NULL OR to_regclass('public.marketing_teams') IS NULL THEN
    RAISE EXCEPTION 'Run 20261017-1900-marketing-p0-settings.sql and 20261023-2000-marketing-lead-chat.sql FIRST.';
  END IF;
END $$;

-- a conversation: a direct message between two people, or a named group
CREATE TABLE IF NOT EXISTS marketing_chat_threads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    uuid NOT NULL REFERENCES marketing_teams(id) ON DELETE RESTRICT,
  kind       text NOT NULL CHECK (kind IN ('dm', 'group')),
  -- a group's name; a direct message has none (each person sees the other's name)
  title      text CHECK (title IS NULL OR length(btrim(title)) BETWEEN 1 AND 80),
  -- a direct message's key: the two user ids, sorted, joined by ':' — one chat per pair of people
  dm_key     text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'dm' AND dm_key IS NOT NULL AND title IS NULL) OR (kind = 'group' AND dm_key IS NULL AND title IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_chat_threads_dm ON marketing_chat_threads (team_id, dm_key) WHERE kind = 'dm';
CREATE INDEX IF NOT EXISTS idx_marketing_chat_threads_team ON marketing_chat_threads (team_id, created_at DESC);

-- who is in a conversation (leaving a group deletes the row; the messages stay in the thread)
CREATE TABLE IF NOT EXISTS marketing_chat_thread_members (
  thread_id uuid NOT NULL REFERENCES marketing_chat_threads(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL,
  added_by  uuid,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_marketing_chat_members_user ON marketing_chat_thread_members (user_id);

CREATE TABLE IF NOT EXISTS marketing_team_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id          uuid NOT NULL REFERENCES marketing_teams(id) ON DELETE RESTRICT,
  thread_id        uuid NOT NULL REFERENCES marketing_chat_threads(id) ON DELETE RESTRICT,
  sender_id        uuid NOT NULL,
  sender_name      text NOT NULL,
  message          text NOT NULL DEFAULT '' CHECK (length(message) <= 5000),
  -- [{ path, name, mime_type, size, flat?, transcript? }] — the file lives in the private bucket under <team_id>/<thread_id>/
  attachments      jsonb,
  reply_to_id      uuid REFERENCES marketing_team_messages(id) ON DELETE SET NULL,
  -- the people named with @ in this message (user ids, members of the conversation)
  mentions         uuid[] NOT NULL DEFAULT '{}',
  edited_at        timestamptz,
  original_message text,
  deleted_at       timestamptz,
  deleted_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (length(btrim(message)) > 0 OR jsonb_array_length(coalesce(attachments, '[]'::jsonb)) > 0 OR deleted_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_marketing_team_messages_thread ON marketing_team_messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_marketing_team_messages_team ON marketing_team_messages (team_id, created_at DESC);

CREATE TABLE IF NOT EXISTS marketing_team_message_reactions (
  message_id uuid NOT NULL REFERENCES marketing_team_messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  user_name  text NOT NULL,
  emoji      text NOT NULL CHECK (length(emoji) BETWEEN 1 AND 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

-- how far each person has read a conversation (also what the unread numbers are counted from)
CREATE TABLE IF NOT EXISTS marketing_team_chat_reads (
  thread_id    uuid NOT NULL REFERENCES marketing_chat_threads(id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES marketing_teams(id) ON DELETE RESTRICT,
  user_id      uuid NOT NULL,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

-- how far each person's device has RECEIVED a conversation (the grey double tick)
CREATE TABLE IF NOT EXISTS marketing_team_chat_delivery (
  thread_id    uuid NOT NULL REFERENCES marketing_chat_threads(id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES marketing_teams(id) ON DELETE RESTRICT,
  user_id      uuid NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

-- @mentions in the chat about a lead (the same column as in the team chat)
ALTER TABLE marketing_lead_messages ADD COLUMN IF NOT EXISTS mentions uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE marketing_chat_threads           ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_chat_thread_members    ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_team_messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_team_message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_team_chat_reads        ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_team_chat_delivery     ENABLE ROW LEVEL SECURITY;

-- Every migration that creates a table ends with the standing lock (tests/unit/migrations-marketing-lock.test.ts enforces it).
SELECT public.marketing_lock_all_tables();
