-- WhatsApp bridge: stop the line's OWN registered business name from being saved as a CLIENT'S chat name.
-- Antonio (2026-10-01): "all messages are marked as Tony Durante LLC instead of with the name of the client."
--
-- Root cause, confirmed live against the real connection: the phone-linking program (GOWA) is reporting
-- "Tony Durante LLC" — this line's own registered WhatsApp Business display name (confirmed via its own
-- /app/devices endpoint) — as the "name" of several unrelated 1:1 client chats (via its /chats endpoint).
-- Our own business identity, leaking onto other people's conversations. This is upstream of anything this
-- codebase controls — the fix here is defensive: never let that specific value land in a chat's saved name,
-- at every point that name gets written, not just where it gets displayed.
--
-- This migration guards wabridge_apply_names (the function the phone's periodic names-sync job calls) the
-- same way it already guards against a "name" that's really just the phone number in disguise. The sibling
-- app-code change guards the OTHER entry point — a brand-new chat's initial name, taken from WhatsApp's own
-- self-reported sender name at the moment the first message arrives (lib/messaging/groups.ts) — and the
-- display layer (lib/messaging/chat-name.ts, OWN_BUSINESS_NAME) is the third, independent layer: even if
-- some future write path reintroduces this value, the screen never shows it as a client's name.
--
-- The literal business name is kept in sync by hand with lib/messaging/chat-name.ts's OWN_BUSINESS_NAME —
-- SQL can't import that file, the same documented trade-off already made for the mime→extension tables
-- elsewhere in messaging. If the line's registered business name is ever deliberately changed, both need
-- updating together.
--
-- Sandbox: node scripts/apply-migration.js scripts/migrations/20261001-1700-wabridge-own-name-guard.sql
-- Production: Antonio runs it in the Supabase SQL editor (execute_sql DDL promotion path is retired).

CREATE OR REPLACE FUNCTION public.wabridge_apply_names(p_channel_id uuid, p_names jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_item jsonb;
  v_digits text;
  v_name text;
  v_rows integer;
  v_total integer := 0;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_names, '[]'::jsonb))
  LOOP
    v_digits := regexp_replace(COALESCE(v_item->>'digits', ''), '\D', '', 'g');
    v_name := btrim(COALESCE(v_item->>'name', ''));
    CONTINUE WHEN length(v_digits) < 6 OR length(v_digits) > 15 OR v_name = ''
      OR regexp_replace(v_name, '\D', '', 'g') = v_digits
      OR lower(v_name) = lower('Tony Durante LLC');
    UPDATE messaging_groups SET group_name = v_name, updated_at = now()
    WHERE channel_id = p_channel_id
      AND external_group_id IN (v_digits || '@c.us', v_digits)
      AND group_name IS DISTINCT FROM v_name;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_total := v_total + v_rows;
  END LOOP;

  INSERT INTO wa_bridge_state (channel_id, names_synced_at) VALUES (p_channel_id, now())
  ON CONFLICT (channel_id) DO UPDATE SET names_synced_at = now();

  RETURN v_total;
END;
$function$;
