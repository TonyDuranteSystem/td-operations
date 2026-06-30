-- Emoji reactions on individual chat messages (CRM + client portal).
-- Reactions are stored ON the message row as a JSONB array so they ride the
-- existing realtime UPDATE handler (both portal use-portal-chat.ts and CRM
-- portal-chats page merge `{ ...m, ...updated }`) and the existing GET
-- `select('*')` for free — no new realtime subscription, no JOIN.
--
-- Element shape:
--   { "emoji": "👍", "reactor_id": "<contact_id | auth.uid | staff uid>",
--     "reactor_type": "client" | "staff", "reactor_name": "Mario" | null,
--     "created_at": "2026-06-30T12:00:00Z" }
--
-- Toggle semantics (Slack-style): a given (emoji, reactor_id) pair is added if
-- absent, removed if present. One reactor may add multiple distinct emojis.

ALTER TABLE portal_messages
  ADD COLUMN IF NOT EXISTS reactions jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Atomic add/remove. Row is locked FOR UPDATE so two simultaneous reactions can
-- never lose an update (read-modify-write race). Returns
--   { "reactions": <new array>, "added": <bool> }
CREATE OR REPLACE FUNCTION toggle_message_reaction(
  p_message_id  uuid,
  p_emoji       text,
  p_reactor_id  text,
  p_reactor_type text,
  p_reactor_name text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_reactions jsonb;
  new_reactions     jsonb;
  was_removed       boolean;
BEGIN
  -- Lock the row; serialize concurrent toggles on the same message.
  SELECT COALESCE(reactions, '[]'::jsonb)
    INTO current_reactions
    FROM portal_messages
   WHERE id = p_message_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'message_not_found';
  END IF;

  -- Drop any existing element matching this (emoji, reactor_id).
  new_reactions := COALESCE((
    SELECT jsonb_agg(elem)
      FROM jsonb_array_elements(current_reactions) elem
     WHERE NOT (elem->>'emoji' = p_emoji AND elem->>'reactor_id' = p_reactor_id)
  ), '[]'::jsonb);

  was_removed := jsonb_array_length(current_reactions) <> jsonb_array_length(new_reactions);

  -- Not present before → this is an ADD; append.
  IF NOT was_removed THEN
    new_reactions := new_reactions || jsonb_build_object(
      'emoji',       p_emoji,
      'reactor_id',  p_reactor_id,
      'reactor_type',p_reactor_type,
      'reactor_name',p_reactor_name,
      'created_at',  now()
    );
  END IF;

  UPDATE portal_messages
     SET reactions = new_reactions
   WHERE id = p_message_id;

  RETURN jsonb_build_object('reactions', new_reactions, 'added', NOT was_removed);
END;
$$;
