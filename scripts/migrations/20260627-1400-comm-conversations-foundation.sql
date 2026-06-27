-- TD Communication — conversation model (foundation, revised)
--
-- A direct, realtime communication channel between TD staff and an external
-- managed PARTNER (first user: Cris). Staff use it from the CRM
-- (/dashboard/td-communication); the partner uses a confined standalone page
-- (/collab) and the /api/conversations endpoints — enforced in middleware.ts.
--
-- NAMING — the generic `conversations` table is already taken (the legacy
-- Airtable/Fireflies comms log, conv_search, /conversations page). To avoid
-- collision these tables are namespaced `comm_*`.
--
-- REALTIME + RLS — unlike the older portal_messages (RLS off), this channel is
-- partner-facing, so it uses RLS ON with a participant-scoped SELECT policy on
-- comm_messages and adds comm_messages to the supabase_realtime publication.
-- The browser subscribes with the user's JWT; postgres_changes only delivers
-- rows the policy admits (a partner sees ONLY their own conversations). All
-- authoritative server reads/writes use the service role (bypasses RLS) after
-- an explicit auth check in app/api/conversations/*.

-- 0) Drop the superseded td_* attempt (sandbox-only, never promoted). ---------
DROP TABLE IF EXISTS td_conversation_messages CASCADE;
DROP TABLE IF EXISTS td_conversation_participants CASCADE;
DROP TABLE IF EXISTS td_conversations CASCADE;

-- 1) Conversations -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS comm_conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject         text,
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'closed', 'archived')),
  partner_id      uuid REFERENCES client_partners(id) ON DELETE SET NULL,
  created_by_type text CHECK (created_by_type IN ('staff', 'partner')),
  created_by_id   text,
  created_by_name text,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_comm_conversations_partner
  ON comm_conversations (partner_id);
CREATE INDEX IF NOT EXISTS idx_comm_conversations_last_message
  ON comm_conversations (last_message_at DESC);

COMMENT ON TABLE comm_conversations IS
  'TD Communication: a staff<->partner conversation thread. Namespaced comm_* to avoid the legacy `conversations` comms-log table.';

-- 2) Participants ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comm_participants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES comm_conversations(id) ON DELETE CASCADE,
  participant_type text NOT NULL CHECK (participant_type IN ('staff', 'partner')),
  -- staff: supabase auth user id (auth.uid()); partner: client_partners.id
  participant_id   text NOT NULL,
  participant_name text,
  last_read_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, participant_type, participant_id)
);

CREATE INDEX IF NOT EXISTS idx_comm_participants_conversation
  ON comm_participants (conversation_id);
CREATE INDEX IF NOT EXISTS idx_comm_participants_lookup
  ON comm_participants (participant_type, participant_id);

COMMENT ON TABLE comm_participants IS
  'TD Communication: who is in a conversation (staff member or partner) + per-participant read tracking. Drives the comm_messages RLS policy.';

-- 3) Messages ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comm_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES comm_conversations(id) ON DELETE CASCADE,
  sender_type     text NOT NULL CHECK (sender_type IN ('staff', 'partner')),
  sender_id       text,
  sender_name     text,
  body            text NOT NULL,
  -- R100 soft-delete: client-visible content is never hard-deleted.
  deleted_at      timestamptz,
  deleted_by      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_comm_messages_conversation
  ON comm_messages (conversation_id, created_at);

COMMENT ON TABLE comm_messages IS
  'TD Communication: messages in a conversation. RLS ON with a participant-scoped SELECT policy + in supabase_realtime so postgres_changes deliver only to participants.';

-- 4) Partner scope -----------------------------------------------------------
ALTER TABLE client_partners
  ADD COLUMN IF NOT EXISTS partner_scope text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN client_partners.partner_scope IS
  'Surfaces this partner may access, e.g. {td_communication}. Checked by the standalone /collab page alongside auth role=partner.';

-- 5) RLS ---------------------------------------------------------------------
-- comm_conversations + comm_participants: RLS ON, no policy → authenticated
-- cannot read directly (the browser never queries them; the API uses the
-- service role, which bypasses RLS). They are NOT in the realtime publication.
ALTER TABLE comm_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE comm_participants  ENABLE ROW LEVEL SECURITY;

-- comm_messages: RLS ON + a participant-scoped SELECT policy so that realtime
-- postgres_changes deliver a row ONLY to its participants.
--   staff  : participant_id = auth.uid()
--   partner: the participant's client_partners row is linked to the caller's
--            contact_id (from the JWT app_metadata).
ALTER TABLE comm_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS comm_messages_participant_select ON comm_messages;
CREATE POLICY comm_messages_participant_select ON comm_messages
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM comm_participants p
      WHERE p.conversation_id = comm_messages.conversation_id
        AND (
          (p.participant_type = 'staff' AND p.participant_id = auth.uid()::text)
          OR
          (p.participant_type = 'partner' AND EXISTS (
            SELECT 1 FROM client_partners cp
            WHERE cp.id::text = p.participant_id
              AND cp.contact_id::text = (auth.jwt() -> 'app_metadata' ->> 'contact_id')
          ))
        )
    )
  );

-- Realtime delivery needs the authenticated role to hold SELECT (RLS then
-- row-filters via the policy above).
GRANT SELECT ON comm_messages TO authenticated;

-- 6) Realtime publication ----------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'comm_messages'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE comm_messages';
  END IF;
  -- Defensive: ensure the dropped td_* tables are not lingering in the pub.
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'td_conversation_messages'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE td_conversation_messages';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'td_conversations'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE td_conversations';
  END IF;
END $$;
