-- Rule test for the WhatsApp message-actions menu's new DB piece (reaction toggle). Runs against a
-- real sandbox message, rolls back via a deliberate RAISE EXCEPTION at the end. Expect "ALL PASS".
DO $$
DECLARE
  mid uuid;
  ch uuid := 'f25e74d8-e32b-4a5b-afaf-3d384cedf8b4';
  gid uuid;
  r jsonb;
  staff1 uuid := '11111111-1111-1111-1111-111111111111';
  staff2 uuid := '22222222-2222-2222-2222-222222222222';
BEGIN
  SELECT id INTO gid FROM messaging_groups WHERE channel_id = ch LIMIT 1;
  INSERT INTO messages (channel_id, group_id, direction, content_type, content_text, created_at)
  VALUES (ch, gid, 'inbound', 'text', 'test message for reaction toggle', now())
  RETURNING id INTO mid;

  -- 1. first react adds
  r := wabridge_toggle_reaction(mid, '👍', staff1, 'Luca');
  ASSERT (r->>'ok')::boolean AND (r->>'added')::boolean, 'first react adds: ' || r::text;
  ASSERT jsonb_array_length(r->'reactions') = 1, 'one reaction stored';

  -- 2. same staff, same emoji again → toggles OFF
  r := wabridge_toggle_reaction(mid, '👍', staff1, 'Luca');
  ASSERT (r->>'ok')::boolean AND NOT (r->>'added')::boolean, 'same emoji again removes: ' || r::text;
  ASSERT jsonb_array_length(r->'reactions') = 0, 'back to zero reactions';

  -- 3. two different staff, same emoji → both stored
  r := wabridge_toggle_reaction(mid, '❤️', staff1, 'Luca');
  r := wabridge_toggle_reaction(mid, '❤️', staff2, 'Antonio');
  ASSERT jsonb_array_length(r->'reactions') = 2, 'two staff, same emoji, both kept: ' || r::text;

  -- 4. one staff can react with a different emoji too (not a toggle-replace)
  r := wabridge_toggle_reaction(mid, '🔥', staff1, 'Luca');
  ASSERT jsonb_array_length(r->'reactions') = 3, 'a second distinct emoji from the same staff adds, not replaces: ' || r::text;

  -- 5. reacting to a message that does not exist is refused cleanly
  r := wabridge_toggle_reaction('00000000-0000-0000-0000-000000000000', '👍', staff1, 'Luca');
  ASSERT r->>'code' = 'not_found', 'missing message refused: ' || r::text;

  -- 6. anon/authenticated locked out
  ASSERT NOT has_function_privilege('anon', 'wabridge_toggle_reaction(uuid,text,uuid,text)', 'execute'), 'anon must not react';
  ASSERT NOT has_function_privilege('authenticated', 'wabridge_toggle_reaction(uuid,text,uuid,text)', 'execute'), 'authenticated must not react';

  RAISE EXCEPTION 'ALL PASS';
END $$;
