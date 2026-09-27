-- Rule test for the voice-media functions. Runs in ONE DO block against the SANDBOX and ends by raising 'ALL PASS' so EVERYTHING rolls back.
-- Usage (repo root): node <scratchpad>/sbx.js -f scripts/wabridge-media-sql-test.sql   → expect an error text containing "ALL PASS".
DO $$
DECLARE
  ch uuid := 'f25e74d8-e32b-4a5b-afaf-3d384cedf8b4';
  g uuid := '3f73e1e4-c9f5-42a2-bb47-b73383c237fe';
  m_new uuid; m_old uuid; m_noext uuid; m_ret uuid;
  r jsonb; path text;
BEGIN
  UPDATE messages SET content_type = 'image' WHERE channel_id = ch AND content_type = 'voice';  -- isolate (rolled back)
  DELETE FROM message_media WHERE channel_id = ch;

  INSERT INTO messages (channel_id, group_id, direction, content_type, external_message_id, created_at) VALUES (ch, g, 'inbound', 'voice', 'TESTNEW1', now() - interval '2 days') RETURNING id INTO m_new;
  INSERT INTO messages (channel_id, group_id, direction, content_type, external_message_id, created_at) VALUES (ch, g, 'inbound', 'voice', 'TESTOLD1', now() - interval '30 days') RETURNING id INTO m_old;
  INSERT INTO messages (channel_id, group_id, direction, content_type, external_message_id, created_at) VALUES (ch, g, 'inbound', 'voice', NULL, now() - interval '1 day') RETURNING id INTO m_noext;

  -- 1. claim hands out the recoverable note, marks the >25-day one expired, ignores the one with no external id
  r := wabridge_media_claim(ch);
  ASSERT (r->>'claimed')::boolean, 'claim 1 should claim: ' || r::text;
  ASSERT r->>'message_id' = m_new::text, 'claimed the wrong note';
  ASSERT r->>'path' = 'voice/' || ch::text || '/' || m_new::text || '.m4a', 'path must be server-built';
  ASSERT r->>'chat_digits' = '12066409886', 'digits';
  ASSERT (SELECT status FROM message_media WHERE message_id = m_old) = 'expired', 'old note should be expired';
  ASSERT NOT EXISTS (SELECT 1 FROM message_media WHERE message_id = m_noext), 'no-external-id note must not get a row';

  -- 2. a second claim right away finds nothing (in flight, not stale)
  r := wabridge_media_claim(ch);
  ASSERT NOT (r->>'claimed')::boolean, 'second claim must be empty: ' || r::text;

  -- 3. finish ready: wrong path refused, bad size refused, then accepted
  path := 'voice/' || ch::text || '/' || m_new::text || '.m4a';
  r := wabridge_media_finish(ch, m_new, 'ready', 'voice/x/y.m4a', 'audio/mp4', 100, 5, 't', 'it', 'w', NULL);
  ASSERT r->>'code' = 'bad_path', 'wrong path must be refused: ' || r::text;
  r := wabridge_media_finish(ch, m_new, 'ready', path, 'audio/mp4', 0, 5, 't', 'it', 'w', NULL);
  ASSERT r->>'code' = 'bad_size', 'size 0 must be refused';
  r := wabridge_media_finish(ch, m_new, 'ready', path, 'audio/mp4', 5000, 19, 'ciao a tutti', 'it', 'whisper', NULL);
  ASSERT (r->>'ok')::boolean AND r->>'status' = 'ready', 'ready must be accepted: ' || r::text;

  -- 4. replay cannot overwrite a ready row
  r := wabridge_media_finish(ch, m_new, 'ready', path, 'audio/mp4', 9999, 99, 'DIFFERENT', 'en', 'x', NULL);
  ASSERT (r->>'already')::boolean, 'replay must be a no-op';
  ASSERT (SELECT transcript FROM message_media WHERE message_id = m_new) = 'ciao a tutti', 'transcript overwritten!';
  r := wabridge_media_finish(ch, m_new, 'failed', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'x');
  ASSERT (r->>'already')::boolean AND (SELECT status FROM message_media WHERE message_id = m_new) = 'ready', 'a late failure must not clobber ready';

  -- 5. wrong channel / unknown note
  r := wabridge_media_finish(gen_random_uuid(), m_new, 'expired', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
  ASSERT r->>'code' = 'not_found', 'other channel must not find it';

  -- 6. failed retries up to 3 attempts, then is terminal
  INSERT INTO messages (channel_id, group_id, direction, content_type, external_message_id, created_at) VALUES (ch, g, 'inbound', 'voice', 'TESTRETRY', now() - interval '3 days') RETURNING id INTO m_ret;
  FOR i IN 1..3 LOOP
    r := wabridge_media_claim(ch);
    ASSERT r->>'message_id' = m_ret::text, 'retry claim ' || i || ': ' || r::text;
    r := wabridge_media_finish(ch, m_ret, 'failed', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'boom');
    ASSERT r->>'status' = CASE WHEN i < 3 THEN 'waiting' ELSE 'failed' END, 'attempt ' || i || ' status: ' || r::text;
  END LOOP;
  r := wabridge_media_claim(ch);
  ASSERT NOT (r->>'claimed')::boolean, 'a failed-out note is never re-claimed';

  -- 7. a claimed-but-abandoned note becomes claimable again after 15 minutes
  UPDATE message_media SET status = 'waiting', attempts = 0 WHERE message_id = m_ret;
  r := wabridge_media_claim(ch);
  ASSERT (r->>'claimed')::boolean, 'reclaim after reset';
  UPDATE message_media SET claimed_at = now() - interval '16 minutes' WHERE message_id = m_ret;
  r := wabridge_media_claim(ch);
  ASSERT (r->>'claimed')::boolean AND r->>'message_id' = m_ret::text, 'stale processing must be reclaimable';

  -- 8. retention: nothing yet, then a 181-day-old ready file is listed, then marked deleted (transcript kept)
  ASSERT wabridge_media_expired_list(180, 200) = '[]'::jsonb, 'nothing to delete yet';
  UPDATE message_media SET ready_at = now() - interval '181 days' WHERE message_id = m_new;
  ASSERT jsonb_array_length(wabridge_media_expired_list(180, 200)) = 1, 'the old file must be listed';
  ASSERT wabridge_media_expired_list(5, 200) <> '[]'::jsonb AND jsonb_array_length(wabridge_media_expired_list(5, 200)) = 1, 'p_days floor is 30, still lists 181d';
  ASSERT wabridge_media_mark_deleted(ARRAY[m_new]) = 1, 'mark deleted';
  ASSERT wabridge_media_mark_deleted(ARRAY[m_new]) = 0, 'mark deleted is idempotent';
  ASSERT (SELECT storage_path IS NULL AND audio_deleted_at IS NOT NULL AND transcript = 'ciao a tutti' FROM message_media WHERE message_id = m_new), 'transcript must survive deletion';

  -- 9. locked down
  ASSERT NOT has_function_privilege('anon', 'wabridge_media_claim(uuid)', 'execute'), 'anon must not execute';
  ASSERT NOT has_function_privilege('authenticated', 'wabridge_media_claim(uuid)', 'execute'), 'authenticated must not execute';
  ASSERT NOT has_table_privilege('authenticated', 'message_media', 'select'), 'authenticated must not read the table';

  RAISE EXCEPTION 'ALL PASS';
END $$;
