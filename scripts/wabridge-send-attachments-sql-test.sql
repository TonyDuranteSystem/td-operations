-- Rule test for the send-attachment functions. Runs against SANDBOX real rows for channel f25e74d8… (isolated by
-- deleting only its own wa_outbox rows first/after). Uses 4 real sandbox chats. Prints 'ALL PASS' on success.
DO $$
DECLARE
  ch uuid := 'f25e74d8-e32b-4a5b-afaf-3d384cedf8b4';
  gA uuid := '3f73e1e4-c9f5-42a2-bb47-b73383c237fe';
  gB uuid := '211ad3ba-c54a-4f30-bc89-601cd46479e3';
  gC uuid := '2c96174c-a6c4-4fa3-9154-5aca3ab2d601';
  gD uuid := '73024f7b-3bfe-4eae-b3b2-a77f40a111af';
  r jsonb; id1 uuid; id2 uuid; id3 uuid; id4 uuid; mid uuid;
BEGIN
  DELETE FROM wa_outbox WHERE channel_id = ch;
  UPDATE wa_bridge_state SET send_mode='live', send_allowlist='{}', send_min_gap_seconds=10, send_hourly_cap=30,
    send_daily_cap=120, send_distinct_per_hour=15, send_distinct_per_day=30, send_same_body_per_hour=2,
    last_heartbeat_at=now(), reachable=true, connected=true, logged_in=true
  WHERE channel_id = ch;
  -- make sure each test chat has at least one inbound message (reply-only requirement)
  INSERT INTO messages (channel_id, group_id, direction, content_type, content_text, created_at)
  SELECT ch, g, 'inbound', 'text', 'hi', now() - interval '1 day' FROM unnest(ARRAY[gA,gB,gC,gD]) g
  WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.group_id = g AND m.direction = 'inbound');

  -- 1. enqueue a voice attachment with no caption: body defaults, path is server-built, status queued (mode live)
  r := wabridge_enqueue_send(gA, 'voice', NULL, 'testmsg-voice-a1', 'audio/mp4', 5000, 'HASH_A', NULL);
  ASSERT (r->>'ok')::boolean, 'enqueue voice A should succeed: ' || r::text;
  id1 := (r->>'id')::uuid;
  ASSERT (SELECT body FROM wa_outbox WHERE id = id1) = '[Voice note]', 'default voice caption';
  ASSERT (SELECT status FROM wa_outbox WHERE id = id1) = 'queued', 'live mode -> queued';
  ASSERT (SELECT media_path FROM wa_outbox WHERE id = id1) = 'outbound/' || ch::text || '/testmsg-voice-a1.m4a', 'server-built path';

  -- 2. a caption is used verbatim when given
  r := wabridge_enqueue_send(gB, 'image', 'Ecco il documento', 'testmsg-image-b1', 'image/jpeg', 20000, 'HASH_B', NULL);
  ASSERT (SELECT body FROM wa_outbox WHERE id = (r->>'id')::uuid) = 'Ecco il documento', 'caption used verbatim';

  -- 3. bad inputs refused
  r := wabridge_enqueue_send(gA, 'exe', NULL, 'testmsg-bad-kind1', 'application/x-msdownload', 100, 'H', NULL);
  ASSERT r->>'code' = 'bad_kind', 'unknown kind refused: ' || r::text;
  r := wabridge_enqueue_send(gA, 'voice', NULL, 'testmsg-bad-size1', 'audio/mp4', 0, 'H', NULL);
  ASSERT r->>'code' = 'bad_size', 'zero size refused';
  r := wabridge_enqueue_send(gA, 'voice', NULL, 'testmsg-bad-size2', 'audio/mp4', 99999999, 'H', NULL);
  ASSERT r->>'code' = 'bad_size', 'oversized refused';
  r := wabridge_enqueue_send(gA, 'voice', NULL, 'testmsg-bad-mime1', NULL, 100, 'H', NULL);
  ASSERT r->>'code' = 'bad_request', 'missing mime refused';

  -- 4. retry with the SAME client id returns the ORIGINAL row, even with a different caption
  r := wabridge_enqueue_send(gA, 'voice', 'a different caption', 'testmsg-voice-a1', 'audio/mp4', 5000, 'HASH_A', NULL);
  ASSERT (r->>'duplicate')::boolean AND (r->>'id')::uuid = id1, 'retry returns the same row';
  ASSERT (SELECT body FROM wa_outbox WHERE id = id1) = '[Voice note]', 'retry must not change the stored caption';

  -- 5. a text-only sender is never handed a voice row (it stays queued, reason held, not nothing_to_send)
  r := wabridge_claim_send(ch, ARRAY['text']);
  ASSERT NOT (r->>'claimed')::boolean AND r->>'reason' = 'held', 'text-only sender must not claim voice/image: ' || r::text;

  -- the 10-second gap floor is not configurable lower; back-date claimed_at between claims to simulate time passing
  -- rather than actually waiting in this test (this only touches THIS channel's test rows, deleted at the top).
  -- 6. a sender that supports voice+image claims the OLDEST queued row first (the voice one)
  r := wabridge_claim_send(ch, ARRAY['text','voice','image']);
  ASSERT (r->>'claimed')::boolean AND r->>'kind' = 'voice' AND (r->>'id')::uuid = id1, 'claims voice in order: ' || r::text;
  ASSERT r->>'media_path' = 'outbound/' || ch::text || '/testmsg-voice-a1.m4a', 'claim returns the media path';

  -- 7. finishing a voice send inserts a message AND a ready message_media row, keyed to the SAME pipeline
  r := wabridge_finish_send(ch, id1, true, 'WAMID-VOICE-1', NULL);
  ASSERT (r->>'ok')::boolean AND r->>'status' = 'sent', 'finish voice send: ' || r::text;
  SELECT id INTO mid FROM messages WHERE external_message_id = 'WAMID-VOICE-1';
  ASSERT mid IS NOT NULL, 'message row created for the voice send';
  ASSERT (SELECT content_type FROM messages WHERE id = mid) = 'voice', 'content_type = voice';
  ASSERT EXISTS (SELECT 1 FROM message_media WHERE message_id = mid AND status = 'ready' AND storage_path = 'outbound/' || ch::text || '/testmsg-voice-a1.m4a'), 'ready message_media row exists';
  UPDATE wa_outbox SET claimed_at = claimed_at - interval '15 seconds' WHERE id = id1;

  -- 8. claim the image row, finish it as FAILED: no message row, status failed
  r := wabridge_claim_send(ch, ARRAY['text','voice','image']);
  ASSERT (r->>'claimed')::boolean AND r->>'kind' = 'image', 'claims the image next: ' || r::text;
  id2 := (r->>'id')::uuid;
  UPDATE wa_outbox SET claimed_at = claimed_at - interval '15 seconds' WHERE id = id2;
  r := wabridge_finish_send(ch, id2, false, NULL, 'upload failed');
  ASSERT (r->>'ok')::boolean AND r->>'status' = 'failed', 'failed finish: ' || r::text;
  ASSERT NOT EXISTS (SELECT 1 FROM messages WHERE metadata->>'outbox_id' = id2::text), 'a failed send must not create a message';

  -- 9. identical-content rule uses the file hash for non-text kinds, not the placeholder body
  r := wabridge_enqueue_send(gA, 'voice', NULL, 'testmsg-voice-same1', 'audio/mp4', 1000, 'HASH_SAME', NULL);
  id3 := (r->>'id')::uuid;
  r := wabridge_enqueue_send(gB, 'voice', NULL, 'testmsg-voice-same2', 'audio/mp4', 1000, 'HASH_SAME', NULL);
  id4 := (r->>'id')::uuid;
  -- claim+"send" both (order between id3/id4 is not asserted — both were enqueued in the same transaction, so
  -- their created_at ties under now(); real usage never ties since each web request is its own transaction),
  -- backdating claimed_at each time to clear the 10 s gap floor for the next claim in this test.
  r := wabridge_claim_send(ch, ARRAY['voice']);
  ASSERT (r->>'claimed')::boolean AND r->>'kind' = 'voice' AND (r->>'id')::uuid IN (id3, id4), 'claims one of the two same-hash voices: ' || r::text;
  UPDATE wa_outbox SET status='sent', sent_at=now(), claimed_at=now()-interval '20 seconds' WHERE id = (r->>'id')::uuid;
  r := wabridge_claim_send(ch, ARRAY['voice']);
  ASSERT (r->>'claimed')::boolean AND r->>'kind' = 'voice' AND (r->>'id')::uuid IN (id3, id4), 'claims the other same-hash voice: ' || r::text;
  UPDATE wa_outbox SET status='sent', sent_at=now(), claimed_at=now()-interval '20 seconds' WHERE id = (r->>'id')::uuid;
  -- a THIRD identical-hash voice to a different person must now be held (2 already sent this hour with that hash)
  r := wabridge_enqueue_send(gC, 'voice', NULL, 'testmsg-voice-same3', 'audio/mp4', 1000, 'HASH_SAME', NULL);
  r := wabridge_claim_send(ch, ARRAY['voice']);
  ASSERT NOT (r->>'claimed')::boolean AND r->>'reason' = 'held', 'a 3rd identical-hash voice to a new person is held: ' || r::text;

  -- 10. resolve_outbox (manual "it was sent") also creates the ready message_media row for a voice kind
  r := wabridge_enqueue_send(gD, 'voice', NULL, 'testmsg-voice-resolve1', 'audio/mp4', 2000, 'HASH_R', NULL);
  r := wabridge_claim_send(ch, ARRAY['voice']);
  ASSERT r->>'kind' = 'voice', 'claim before resolve test';
  UPDATE wa_outbox SET claimed_at = now() - interval '3 minutes' WHERE id = (r->>'id')::uuid; -- resolve refuses anything claimed < 2 min ago
  r := wabridge_resolve_outbox((r->>'id')::uuid, 'sent', NULL);
  ASSERT (r->>'ok')::boolean AND r->>'status' = 'sent', 'resolve sent: ' || r::text;
  ASSERT EXISTS (
    SELECT 1 FROM message_media mm JOIN messages m ON m.id = mm.message_id
    WHERE m.metadata->>'outbox_id' = (SELECT id::text FROM wa_outbox WHERE client_msg_id = 'testmsg-voice-resolve1')
      AND mm.status = 'ready'
  ), 'resolve-sent creates a ready message_media row for voice';

  -- 11. hourly cap still applies across kinds (mixed count)
  UPDATE wa_bridge_state SET send_hourly_cap = 1 WHERE channel_id = ch; -- already have >=1 sent this hour from above
  r := wabridge_claim_send(ch, ARRAY['text','voice','image']);
  ASSERT r->>'reason' = 'hourly_cap', 'hourly cap enforced across kinds: ' || r::text;

  -- 12b. the stored path always carries a REAL extension for the file's type (the WhatsApp program picks how to
  -- handle a file by the URL's extension, not the declared mime — a generic one makes it refuse the send)
  r := wabridge_enqueue_send(gC, 'image', NULL, 'testmsg-ext-jpg', 'image/jpeg', 100, 'HX1', NULL);
  ASSERT (r->>'path') LIKE '%.jpg', 'jpeg gets a .jpg extension: ' || r::text;
  r := wabridge_enqueue_send(gD, 'document', NULL, 'testmsg-ext-pdf', 'application/pdf', 100, 'HX2', NULL);
  ASSERT (r->>'path') LIKE '%.pdf', 'pdf gets a .pdf extension: ' || r::text;
  r := wabridge_enqueue_send(gA, 'video', NULL, 'testmsg-ext-unknown', 'application/octet-stream', 100, 'HX3', NULL);
  ASSERT (r->>'path') LIKE '%.bin', 'an unrecognised mime falls back to .bin, never a wrong/misleading extension: ' || r::text;

  -- 12. anon/authenticated locked out of the new function
  ASSERT NOT has_function_privilege('anon', 'wabridge_enqueue_send(uuid,text,text,text,text,integer,text,uuid)', 'execute'), 'anon must not enqueue';
  ASSERT NOT has_function_privilege('authenticated', 'wabridge_enqueue_send(uuid,text,text,text,text,integer,text,uuid)', 'execute'), 'authenticated must not enqueue';

  RAISE EXCEPTION 'ALL PASS';
END $$;
