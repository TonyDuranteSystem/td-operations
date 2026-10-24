-- TD Marketing: the chat inside every lead, between the setter and the seller (dev job 9aec66fa, plan Addendum G).
-- Marketing-only copies of the shapes TD Talk uses (messages, reactions, who has read, what has been delivered) so the marketing team's chat never
-- touches the CRM's own chat tables. Files and voice notes go in a PRIVATE bucket and are served by short-lived signed links.
-- Requires 20261019-1000 (marketing_leads) and 20261017-1900 (marketing_teams).
DO $$
BEGIN
  IF to_regclass('public.marketing_leads') IS NULL OR to_regclass('public.marketing_teams') IS NULL THEN
    RAISE EXCEPTION 'Run 20261017-1900-marketing-p0-settings.sql and 20261019-1000-marketing-leads.sql FIRST.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS marketing_lead_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id          uuid NOT NULL REFERENCES marketing_teams(id) ON DELETE RESTRICT,
  lead_id          uuid NOT NULL REFERENCES marketing_leads(id) ON DELETE RESTRICT,
  sender_id        uuid NOT NULL,
  sender_name      text NOT NULL,
  message          text NOT NULL DEFAULT '' CHECK (length(message) <= 5000),
  -- [{ path, name, mime_type, size, flat?, transcript? }] — the file lives in the private bucket under <team_id>/<lead_id>/
  attachments      jsonb,
  reply_to_id      uuid REFERENCES marketing_lead_messages(id) ON DELETE SET NULL,
  edited_at        timestamptz,
  original_message text,
  deleted_at       timestamptz,
  deleted_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (length(btrim(message)) > 0 OR jsonb_array_length(coalesce(attachments, '[]'::jsonb)) > 0 OR deleted_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_marketing_lead_messages_lead ON marketing_lead_messages (lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_marketing_lead_messages_team ON marketing_lead_messages (team_id, created_at DESC);

CREATE TABLE IF NOT EXISTS marketing_lead_message_reactions (
  message_id uuid NOT NULL REFERENCES marketing_lead_messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  user_name  text NOT NULL,
  emoji      text NOT NULL CHECK (length(emoji) BETWEEN 1 AND 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

-- how far each person has read a lead's chat (also what the unread numbers are counted from)
CREATE TABLE IF NOT EXISTS marketing_lead_chat_reads (
  lead_id      uuid NOT NULL REFERENCES marketing_leads(id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES marketing_teams(id) ON DELETE RESTRICT,
  user_id      uuid NOT NULL,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, user_id)
);

-- how far each person's device has RECEIVED a lead's chat (the grey double tick)
CREATE TABLE IF NOT EXISTS marketing_lead_chat_delivery (
  lead_id      uuid NOT NULL REFERENCES marketing_leads(id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES marketing_teams(id) ON DELETE RESTRICT,
  user_id      uuid NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, user_id)
);

-- phone/computer notifications for the marketing team (its own table: the staff table is for staff only)
CREATE TABLE IF NOT EXISTS marketing_push_subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    uuid NOT NULL REFERENCES marketing_teams(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  endpoint   text NOT NULL,
  p256dh     text NOT NULL,
  auth_key   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_marketing_push_team ON marketing_push_subscriptions (team_id);

ALTER TABLE marketing_lead_messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_lead_message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_lead_chat_reads        ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_lead_chat_delivery     ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_push_subscriptions     ENABLE ROW LEVEL SECURITY;

-- The private bucket. Storage itself enforces what may land there (a signed upload link does not restrict the content type),
-- so nobody can put an HTML page or an executable in the chat.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('marketing-chat', 'marketing-chat', false, 52428800,  -- 50 MiB
        ARRAY['audio/mp4','audio/x-m4a','audio/aac','audio/mpeg','audio/ogg','audio/webm','audio/wav',
              'image/jpeg','image/png','image/gif','image/webp','image/heic','image/heif',
              'application/pdf','text/plain','text/csv',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'application/vnd.openxmlformats-officedocument.presentationml.presentation'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 52428800,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Every migration that creates a table ends with the standing lock (tests/unit/migrations-marketing-lock.test.ts enforces it).
SELECT public.marketing_lock_all_tables();
