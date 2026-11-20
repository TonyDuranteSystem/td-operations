-- Reactions in WhatsApp GROUPS, both directions (2026-11-20, Antonio's full audit of groups).
-- 1) CRM -> group: wabridge_queue_phone_reaction accepted only one-to-one chats ("not_one_to_one"). It now also accepts a group chat; for a
--    group `wa_reaction_sync.to_digits` holds the group's own id (`<digits>@g.us`), like the send queue does. Every other rule is unchanged
--    (reaction switch, allow list, reply-only, 1-hour age limit, pacing, caps — the claim function compares to_digits as plain text).
-- 2) Group -> CRM: wabridge_apply_observed_reactions accepted one chat shape and TWO reactors (client / line). In a group every member is their
--    own reactor: an item may carry `reactor` (digits of the member); their reaction is stored as
--    {reactor_type:'client', reactor_id:'wa-client:<digits>', reactor_name:<name from messaging_groups.members, else null>}. One-to-one items
--    (no `reactor`) behave exactly as before. The chat may now be a group id (6-30 digits).
-- Both functions are rewritten IN PLACE from their live definitions; each replacement is checked (the script refuses to run if a line is
-- not found) and a marker `-- group-reactions` makes a second run a no-op.

DO $mig$
DECLARE
  v_oid oid;
  v_def text;
  v_new text;
BEGIN
  -- ── 1) CRM → group ──
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'wabridge_queue_phone_reaction';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'group-reactions: wabridge_queue_phone_reaction not found'; END IF;
  v_def := pg_get_functiondef(v_oid);
  IF position('-- group-reactions' IN v_def) = 0 THEN
    v_new := replace(v_def,
      $a$m.external_group_id !~ '^[0-9]{6,15}(@(s\.whatsapp\.net|c\.us))?$' THEN$a$,
      $b$m.external_group_id !~ '^[0-9]{6,15}(@(s\.whatsapp\.net|c\.us))?$' AND m.external_group_id !~ '^[0-9]{8,30}(-[0-9]+)?@g\.us$' THEN -- group-reactions$b$);
    IF v_new = v_def THEN RAISE EXCEPTION 'group-reactions: queue guard not found'; END IF;
    v_def := v_new;
    v_new := replace(v_def,
      $a$v_digits := regexp_replace(m.external_group_id, '@.*$', '');$a$,
      $b$v_digits := CASE WHEN m.external_group_id ~ '@g\.us$' THEN m.external_group_id ELSE regexp_replace(m.external_group_id, '@.*$', '') END;$b$);
    IF v_new = v_def THEN RAISE EXCEPTION 'group-reactions: queue digits line not found'; END IF;
    EXECUTE v_new;
  END IF;

  -- ── 2) group → CRM ──
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'wabridge_apply_observed_reactions';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'group-reactions: wabridge_apply_observed_reactions not found'; END IF;
  v_def := pg_get_functiondef(v_oid);
  IF position('-- group-reactions' IN v_def) = 0 THEN
    v_new := replace(v_def, E'  v_healthy boolean;\nBEGIN', E'  v_healthy boolean;\n  v_reactor text; -- group-reactions\n  v_rid text;\n  v_rname text;\nBEGIN');
    IF v_new = v_def THEN RAISE EXCEPTION 'group-reactions: declare block not found'; END IF;
    v_def := v_new;
    v_new := replace(v_def,
      $a$v_emoji := it->>'emoji';$a$,
      $b$v_emoji := it->>'emoji';
    v_reactor := NULLIF(it->>'reactor', '');
    IF v_reactor IS NOT NULL AND (v_reactor !~ '^[0-9]{5,30}$' OR v_side IS DISTINCT FROM 'client') THEN
      v_res := v_res || jsonb_build_array(jsonb_build_object('i', v_i, 'r', 'invalid'));
      CONTINUE;
    END IF;
    v_rid := CASE WHEN v_reactor IS NOT NULL THEN 'wa-client:' || v_reactor ELSE 'wa-' || v_side END;$b$);
    IF v_new = v_def THEN RAISE EXCEPTION 'group-reactions: emoji line not found'; END IF;
    v_def := v_new;
    v_new := replace(v_def, $a$v_chat !~ '^[0-9]{6,15}$'$a$, $b$v_chat !~ '^[0-9]{6,30}$'$b$);
    IF v_new = v_def THEN RAISE EXCEPTION 'group-reactions: chat check not found'; END IF;
    v_def := v_new;
    v_new := replace(v_def,
      E'    v_idx := NULL;\n    v_elem := NULL;',
      E'    v_rname := NULL;\n    IF v_reactor IS NOT NULL THEN\n      SELECT mm->>''name'' INTO v_rname\n        FROM messaging_groups g2, jsonb_array_elements(COALESCE(g2.members, ''[]''::jsonb)) mm\n       WHERE g2.channel_id = p_channel_id AND g2.external_group_id = v_chat || ''@g.us''\n         AND regexp_replace(COALESCE(mm->>''phone'', ''''), ''\\D'', '''', ''g'') = v_reactor\n       LIMIT 1;\n    END IF;\n    v_idx := NULL;\n    v_elem := NULL;');
    IF v_new = v_def THEN RAISE EXCEPTION 'group-reactions: lookup anchor not found'; END IF;
    v_def := v_new;
    v_new := replace(v_def,
      $a$WHERE t.elem->>'reactor_type' = v_side$a$,
      $b$WHERE t.elem->>'reactor_type' = v_side AND COALESCE(t.elem->>'reactor_id', 'wa-' || v_side) = v_rid$b$);
    IF v_new = v_def THEN RAISE EXCEPTION 'group-reactions: element lookup not found'; END IF;
    v_def := v_new;
    v_new := replace(v_def, $a$'reactor_id', 'wa-' || v_side,$a$, $b$'reactor_id', v_rid,$b$);
    IF v_new = v_def THEN RAISE EXCEPTION 'group-reactions: reactor_id not found'; END IF;
    v_def := v_new;
    v_new := replace(v_def, $a$'reactor_name', NULL,$a$, $b$'reactor_name', v_rname,$b$);
    IF v_new = v_def THEN RAISE EXCEPTION 'group-reactions: reactor_name not found'; END IF;
    EXECUTE v_new;
  END IF;
END
$mig$;
