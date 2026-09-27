-- Rule test: reply-to-a-message threading survives the full queue → send → real row round trip.
DO $$
DECLARE
  ch uuid := 'f25e74d8-e32b-4a5b-afaf-3d384cedf8b4';
  gid uuid;
  target_id uuid;
  r jsonb;
  ob_id uuid;
  sent_id uuid;
BEGIN
  SELECT id INTO gid FROM messaging_groups WHERE channel_id = ch LIMIT 1;
  UPDATE wa_bridge_state SET send_mode='live', send_allowlist='{}' WHERE channel_id = ch;

  INSERT INTO messages (channel_id, group_id, direction, content_type, content_text, created_at)
  VALUES (ch, gid, 'inbound', 'text', 'the original message being replied to', now() - interval '1 hour')
  RETURNING id INTO target_id;

  -- 1. a reply-to pointing at a real message in the same chat is accepted and stored on the queue row
  r := wabridge_enqueue_reply(gid, 'here is my reply', 'test-reply-1', NULL, target_id);
  ASSERT (r->>'ok')::boolean, 'enqueue with reply_to succeeds: ' || r::text;
  ob_id := (r->>'id')::uuid;
  ASSERT (SELECT reply_to_id FROM wa_outbox WHERE id = ob_id) = target_id, 'reply_to_id stored on the queue row';

  -- 2. a reply-to pointing at a message in a DIFFERENT chat is refused
  r := wabridge_enqueue_reply(gid, 'bad reply', 'test-reply-bad', NULL, '00000000-0000-0000-0000-000000000000');
  ASSERT r->>'code' = 'bad_reply_to', 'reply to a nonexistent message refused: ' || r::text;

  -- 3. finishing the send carries reply_to_id onto the REAL messages row
  UPDATE wa_outbox SET status = 'unknown', claimed_at = now() WHERE id = ob_id;
  r := wabridge_finish_send(ch, ob_id, true, 'WAMID-REPLY-TEST-1', NULL);
  ASSERT (r->>'ok')::boolean AND r->>'status' = 'sent', 'finish send: ' || r::text;
  SELECT id INTO sent_id FROM messages WHERE external_message_id = 'WAMID-REPLY-TEST-1';
  ASSERT sent_id IS NOT NULL, 'the real message row was created';
  ASSERT (SELECT reply_to_id FROM messages WHERE id = sent_id) = target_id, 'reply_to_id carried through to the real row';

  -- 4. a normal reply with no reply-to still works exactly as before (never broke by the new param)
  r := wabridge_enqueue_reply(gid, 'a plain reply, no quoting', 'test-reply-plain', NULL);
  ASSERT (r->>'ok')::boolean, 'plain reply with no reply_to still works: ' || r::text;

  RAISE EXCEPTION 'ALL PASS';
END $$;
