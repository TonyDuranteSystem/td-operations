-- WhatsApp messages get the same per-message "three dots" menu Portal Chats already has (dev job
-- 907b2535, Antonio 2026-09-27: "full menu"). Two items from that menu do NOT map onto WhatsApp and
-- are deliberately left out here: "Edit message" (WhatsApp's real message on the person's real phone
-- never changes — editing our own copy would just make it lie about what they actually received) and
-- true unsend (WhatsApp's real message on their phone cannot be recalled from here — "Delete" is
-- relabeled in the UI to make clear it only hides our own copy, matching R100's existing "client never
-- sees a partial deletion" shape but reversed: here it's the STAFF-side view being hidden, the real
-- message stays exactly where WhatsApp actually put it).
--
-- Reused AS-IS, no schema change needed (confirmed no FK / hard-coded-table blockers before writing
-- this): "Discuss with Team" (internal_threads.source_message_id has no FK, any uuid text is fine),
-- "Share to team chat" (client-side only, generic entity_type/entity_id), "Make a note" (sticky notes
-- take freeform prefill + account/contact + an origin URL, no message FK), "Create Task/Service/
-- Invoice" (quick-create dialogs take freeform messageText, no message FK), "Tag Message" + "To Do"
-- (message_actions.message_id is ALREADY nullable and the board ALREADY renders special card bodies
-- from a free-text `source_ref` prefix for non-portal-message cards, e.g. 'tax_submission:<id>' —
-- WhatsApp cards use source_ref = 'wa_message:<messages.id>', exactly that same established pattern,
-- zero schema change, zero risk to the live message_actions/To-Do board system).
--
-- New here: reactions, pin, reply-to-a-message, and the soft "hide from our view" — WhatsApp's own
-- `messages` table has none of the columns portal_messages already has for these, so this migration
-- adds them, matching portal_messages' own column shapes exactly (see reactions shape in
-- lib/portal/reactions.ts, shared and already DB-agnostic — reused, not reimplemented).

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS reactions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS pinned_at timestamptz;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS deleted_by uuid;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS reply_to_id uuid REFERENCES public.messages(id);

-- Atomic toggle for a WhatsApp message reaction — staff only (there is no client-facing widget for
-- WhatsApp; unlike toggle_message_reaction for portal_messages, no client/teammate reactor path).
-- Slack-style: re-sending the same emoji from the same staff member removes it; different emoji adds.
CREATE OR REPLACE FUNCTION public.wabridge_toggle_reaction(
  p_message_id uuid, p_emoji text, p_reactor_id uuid, p_reactor_name text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reactions jsonb;
  v_existing_idx int;
  v_added boolean;
  v_new jsonb;
BEGIN
  SELECT reactions INTO v_reactions FROM messages WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  v_reactions := COALESCE(v_reactions, '[]'::jsonb);

  SELECT i - 1 INTO v_existing_idx
  FROM jsonb_array_elements(v_reactions) WITH ORDINALITY AS t(elem, i)
  WHERE (elem->>'reactor_id') = p_reactor_id::text AND (elem->>'emoji') = p_emoji
  LIMIT 1;

  IF v_existing_idx IS NOT NULL THEN
    v_reactions := v_reactions - v_existing_idx;
    v_added := false;
  ELSE
    v_new := jsonb_build_object(
      'emoji', p_emoji, 'reactor_id', p_reactor_id::text, 'reactor_type', 'staff',
      'reactor_name', p_reactor_name, 'created_at', now()
    );
    v_reactions := v_reactions || jsonb_build_array(v_new);
    v_added := true;
  END IF;

  UPDATE messages SET reactions = v_reactions WHERE id = p_message_id;
  RETURN jsonb_build_object('ok', true, 'added', v_added, 'reactions', v_reactions);
END;
$$;

REVOKE ALL ON FUNCTION public.wabridge_toggle_reaction(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_toggle_reaction(uuid, text, uuid, text) TO service_role;
