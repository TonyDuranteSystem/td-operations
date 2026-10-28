-- Rule test for the on-demand pairing code + Recover functions (migration 20261028-2000). Runs in ONE DO block against the SANDBOX and
-- ends by raising 'ALL PASS' so EVERYTHING rolls back.
-- Usage: run this file with any SQL runner against the sandbox → expect an error text containing "ALL PASS".
DO $$
DECLARE
  ch uuid := 'f25e74d8-e32b-4a5b-afaf-3d384cedf8b4';
  r jsonb; ok boolean; n int;
BEGIN
  INSERT INTO wa_bridge_state (channel_id, last_heartbeat_at, reachable, connected, logged_in) VALUES (ch, now(), true, false, false)
  ON CONFLICT (channel_id) DO NOTHING;
  UPDATE wa_bridge_state SET logged_in = false, link_attempts = 0, link_window_at = NULL, link_code = NULL, link_code_at = NULL,
    link_code_wanted_at = NULL, recover_requested_at = NULL, recover_started_at = NULL, recover_done_at = NULL, recover_saved = NULL, recover_read = NULL
  WHERE channel_id = ch;

  -- ===== pairing code on demand =====
  -- 1. nothing wanted yet → the Mac is told nothing
  r := wabridge_take_commands(ch);
  ASSERT (r->>'want_code')::boolean = false AND r->'recover_days' = 'null'::jsonb, 'idle commands wrong: ' || r::text;

  -- 2. "Get a new code" → the next beat is told to fetch one
  r := wabridge_request_link_code(ch);
  ASSERT r->>'result' = 'ok', 'request code should be ok: ' || r::text;
  r := wabridge_take_commands(ch);
  ASSERT (r->>'want_code')::boolean, 'wanted code not handed out: ' || r::text;

  -- 3. storing the code clears the request and starts the hour window
  ok := wabridge_set_link_code(ch, 'ABCD-1234');
  ASSERT ok, 'first code should be stored';
  r := wabridge_take_commands(ch);
  ASSERT (r->>'want_code')::boolean = false, 'request should be cleared after the code arrives: ' || r::text;
  ASSERT (SELECT link_attempts FROM wa_bridge_state WHERE channel_id = ch) = 1, 'attempt count should be 1';

  -- 4. five codes in one hour are allowed, the sixth is refused AND the request is refused with a retry time
  FOR n IN 2..5 LOOP
    ok := wabridge_set_link_code(ch, 'ABCD-123' || n::text);
    ASSERT ok, 'code ' || n || ' should be stored';
  END LOOP;
  ok := wabridge_set_link_code(ch, 'ZZZZ-9999');
  ASSERT NOT ok, 'sixth code in the hour must be refused';
  r := wabridge_request_link_code(ch);
  ASSERT r->>'result' = 'limit' AND r->>'retry_at' IS NOT NULL, 'request past the cap should say limit with a retry time: ' || r::text;

  -- 5. once the hour is over, codes work again (no lock-out until a manual reset)
  UPDATE wa_bridge_state SET link_window_at = now() - interval '61 minutes' WHERE channel_id = ch;
  r := wabridge_request_link_code(ch);
  ASSERT r->>'result' = 'ok', 'after the hour a request should be ok again: ' || r::text;
  ok := wabridge_set_link_code(ch, 'NEWW-0001');
  ASSERT ok AND (SELECT link_attempts FROM wa_bridge_state WHERE channel_id = ch) = 1, 'a new hour must restart the count at 1';

  -- 6. a request that was never answered goes stale after 5 minutes
  UPDATE wa_bridge_state SET link_code_wanted_at = now() - interval '6 minutes' WHERE channel_id = ch;
  r := wabridge_take_commands(ch);
  ASSERT (r->>'want_code')::boolean = false, 'a 6-minute-old request must not be handed out';

  -- 7. nothing to do when the device is already logged in
  UPDATE wa_bridge_state SET logged_in = true WHERE channel_id = ch;
  r := wabridge_request_link_code(ch);
  ASSERT r->>'result' = 'linked', 'logged in → linked: ' || r::text;
  ok := wabridge_set_link_code(ch, 'LATE-0000');
  ASSERT NOT ok, 'no code may be stored while logged in';
  UPDATE wa_bridge_state SET logged_in = false WHERE channel_id = ch;

  -- ===== recover missing messages =====
  r := wabridge_request_recover(ch);
  ASSERT r->>'result' = 'ok', 'recover request should be ok: ' || r::text;
  r := wabridge_request_recover(ch);
  ASSERT r->>'result' = 'already', 'a second click while one is pending must say already: ' || r::text;

  -- the job is handed to the Mac ONCE
  r := wabridge_take_commands(ch);
  ASSERT (r->>'recover_days')::int = 7, 'recover job should be handed out (7 days): ' || r::text;
  r := wabridge_take_commands(ch);
  ASSERT r->'recover_days' = 'null'::jsonb, 'recover job must not be handed out twice: ' || r::text;

  -- re-offered only if handed out > 3 min ago and never reported
  UPDATE wa_bridge_state SET recover_started_at = now() - interval '4 minutes' WHERE channel_id = ch;
  r := wabridge_take_commands(ch);
  ASSERT (r->>'recover_days')::int = 7, 'a lost recover job should be re-offered after 3 minutes: ' || r::text;

  -- the Mac reports; it is recorded once
  ok := wabridge_set_recover_result(ch, 1, 26);
  ASSERT ok, 'result should be recorded';
  ASSERT (SELECT recover_saved FROM wa_bridge_state WHERE channel_id = ch) = 1 AND (SELECT recover_read FROM wa_bridge_state WHERE channel_id = ch) = 26, 'result numbers wrong';
  ok := wabridge_set_recover_result(ch, 9, 9);
  ASSERT NOT ok, 'a second report must not overwrite the first';
  r := wabridge_take_commands(ch);
  ASSERT r->'recover_days' = 'null'::jsonb, 'a finished job must not be handed out again';

  -- a new press after it finished starts a fresh job
  r := wabridge_request_recover(ch);
  ASSERT r->>'result' = 'ok' AND (SELECT recover_done_at FROM wa_bridge_state WHERE channel_id = ch) IS NULL, 'a new request after completion should reset the result: ' || r::text;

  -- an old unanswered job (> 5 min) is dropped, and a new press is allowed again
  UPDATE wa_bridge_state SET recover_requested_at = now() - interval '6 minutes', recover_started_at = NULL WHERE channel_id = ch;
  r := wabridge_take_commands(ch);
  ASSERT r->'recover_days' = 'null'::jsonb, 'an expired recover job must not be handed out';
  r := wabridge_request_recover(ch);
  ASSERT r->>'result' = 'ok', 'a press after an expired job should be ok: ' || r::text;

  RAISE EXCEPTION 'ALL PASS';
END $$;
