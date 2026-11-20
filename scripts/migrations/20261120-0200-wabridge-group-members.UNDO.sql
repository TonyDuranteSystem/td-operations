-- Undo: the column stays (harmless, ignored); put the previous group-listing function back (name only).
CREATE OR REPLACE FUNCTION public.wabridge_apply_groups(p_channel_id uuid, p_groups jsonb)
 RETURNS integer LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_item jsonb; v_jid text; v_name text; v_changed integer := 0; v_rows integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM messaging_channels c WHERE c.id = p_channel_id AND c.provider = 'wabridge') THEN RETURN 0; END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_groups, '[]'::jsonb)) LOOP
    v_jid := v_item->>'jid'; v_name := NULLIF(btrim(COALESCE(v_item->>'name', '')), '');
    IF v_jid IS NULL OR v_jid !~ '^[0-9]{8,30}(-[0-9]+)?@g\.us$' THEN CONTINUE; END IF;
    INSERT INTO messaging_groups (channel_id, external_group_id, group_name, group_type, is_active, last_message_at)
    VALUES (p_channel_id, v_jid, v_name, 'support_group', true, now())
    ON CONFLICT (channel_id, external_group_id) DO UPDATE SET group_name = EXCLUDED.group_name, updated_at = now()
      WHERE EXCLUDED.group_name IS NOT NULL AND messaging_groups.group_name IS DISTINCT FROM EXCLUDED.group_name;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_changed := v_changed + v_rows;
  END LOOP;
  RETURN v_changed;
END;
$function$;
