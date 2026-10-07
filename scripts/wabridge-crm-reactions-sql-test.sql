-- Rule test for the CRM → phone reaction lane (dev job 5962e46d, Release 2): wabridge_queue_phone_reaction / claim / finish / switches.
-- Runs against a real sandbox chat, rolls back via a deliberate RAISE EXCEPTION at the end. Expect "ALL PASS".
DO $$
DECLARE
  ch uuid;
  gid uuid;
  digits text;
  mid uuid;
  mid_old uuid;
  ext text := 'TESTRXN' || floor(random() * 1e9)::bigint::text;
  ext_old text := 'TESTOLD' || floor(random() * 1e9)::bigint::text;
  r jsonb;
  reacts jsonb;
  lane record;
  staff1 uuid := '11111111-1111-1111-1111-111111111111';
  before_unread int;
  before_last timestamptz;
  after_unread int;
  after_last timestamptz;
  line_count int;
BEGIN
  SELECT id INTO ch FROM messaging_channels WHERE provider = 'wabridge' LIMIT 1;
  SELECT g.id, regexp_replace(g.external_group_id, '@.*$', '') INTO gid, digits
    FROM messaging_groups g
   WHERE g.channel_id = ch AND g.is_active AND g.external_group_id ~ '^[0-9]{6,15}(@(s\.whatsapp\.net|c\.us))?$' LIMIT 1;
  ASSERT gid IS NOT NULL, 'sandbox needs one active 1:1 chat on the wabridge channel';
  INSERT INTO messages (channel_id, group_id, direction, content_type, content_text, created_at, external_message_id)
  VALUES (ch, gid, 'inbound', 'text', 'reaction lane test', now(), ext) RETURNING id INTO mid;
  INSERT INTO messages (channel_id, group_id, direction, content_type, content_text, created_at, external_message_id)
  VALUES (ch, gid, 'inbound', 'text', 'an old one', now() - interval '2 hours', ext_old) RETURNING id INTO mid_old;
  SELECT unread_count, last_message_at INTO before_unread, before_last FROM messaging_groups WHERE id = gid;

  -- a healthy bridge with a live reader (rolled back with everything else); switch OFF, nobody allowed
  UPDATE wa_bridge_state SET reachable = true, connected = true, logged_in = true, last_heartbeat_at = now(), reactions_seen_at = now(),
         reactions_mode = 'off', reactions_allowlist = '{}', reactions_allow_all = false,
         reactions_min_gap_seconds = 4, reactions_hourly_cap = 40, reactions_daily_cap = 200, reactions_per_chat_hour = 12
   WHERE channel_id = ch;
  DELETE FROM wa_reaction_sync WHERE channel_id = ch;
  PERFORM wabridge_toggle_reaction(mid, '🔥', staff1, 'Luca'); -- a CRM-only team mark that must survive everything

  -- 1. OFF by default: nothing queued, no lane row
  r := wabridge_queue_phone_reaction(mid, '👍', 'set', staff1);
  ASSERT (r->>'ok')::boolean AND NOT (r->>'queued')::boolean AND r->>'reason' = 'off', 'off by default: ' || r::text;
  ASSERT NOT EXISTS (SELECT 1 FROM wa_reaction_sync WHERE message_id = mid), 'no lane row while off';

  -- 2. going live with nobody allowed is refused; an allowlist makes it possible
  r := wabridge_set_reactions_mode(ch, 'live');
  ASSERT NOT (r->>'ok')::boolean AND r->>'code' = 'empty_allowlist', 'empty allowlist refused: ' || r::text;
  r := wabridge_set_reactions_mode(ch, 'bogus');
  ASSERT r->>'code' = 'bad_mode', 'bad mode refused';
  PERFORM wabridge_set_reactions_allowlist(ch, ARRAY['+99 000 111 22']); -- someone else's number
  PERFORM wabridge_set_reactions_mode(ch, 'live');

  -- 3. not on the allowlist → refused with a reason (CRM mark is untouched)
  r := wabridge_queue_phone_reaction(mid, '👍', 'set', staff1);
  ASSERT NOT (r->>'queued')::boolean AND r->>'reason' = 'not_allowed', 'not allowlisted: ' || r::text;
  PERFORM wabridge_set_reactions_allowlist(ch, ARRAY[digits]);

  -- 4. the other gates
  r := wabridge_queue_phone_reaction(mid_old, '👍', 'set', staff1);
  ASSERT r->>'reason' = 'too_old', 'older than 1 hour: ' || r::text;
  r := wabridge_queue_phone_reaction(mid, '🧨', 'set', staff1);
  ASSERT r->>'reason' = 'bad_emoji', 'emoji outside the safe set: ' || r::text;
  ASSERT wabridge_react_safe_emoji('❤️') AND wabridge_react_safe_emoji('👍') AND NOT wabridge_react_safe_emoji('🧨') AND NOT wabridge_react_safe_emoji(''), 'safe set (with and without U+FE0F)';
  UPDATE messages SET external_message_id = NULL WHERE id = mid;
  r := wabridge_queue_phone_reaction(mid, '👍', 'set', staff1);
  ASSERT r->>'reason' = 'no_message_id', 'no program id: ' || r::text;
  UPDATE messages SET external_message_id = ext WHERE id = mid;
  UPDATE wa_bridge_state SET last_heartbeat_at = now() - interval '10 minutes' WHERE channel_id = ch;
  r := wabridge_queue_phone_reaction(mid, '👍', 'set', staff1);
  ASSERT r->>'reason' = 'offline', 'bridge offline: ' || r::text;
  UPDATE wa_bridge_state SET last_heartbeat_at = now() WHERE channel_id = ch;
  UPDATE messaging_groups SET external_group_id = external_group_id || '@g.us' WHERE id = gid;
  r := wabridge_queue_phone_reaction(mid, '👍', 'set', staff1);
  ASSERT r->>'reason' = 'not_one_to_one', 'a group chat: ' || r::text;
  UPDATE messaging_groups SET external_group_id = replace(external_group_id, '@g.us', '') WHERE id = gid;
  r := wabridge_queue_phone_reaction(gen_random_uuid(), '👍', 'set', staff1);
  ASSERT NOT (r->>'ok')::boolean AND r->>'code' = 'not_found', 'unknown message';
  r := wabridge_queue_phone_reaction(mid, '👍', 'sideways', staff1);
  ASSERT r->>'code' = 'bad_request', 'bad action';
  ASSERT NOT EXISTS (SELECT 1 FROM wa_reaction_sync WHERE channel_id = ch), 'every refusal left no lane row';

  -- 5. a pick is queued, then HELD 10 s (undo window): nothing to claim yet
  r := wabridge_queue_phone_reaction(mid, '👍', 'set', staff1);
  ASSERT (r->>'queued')::boolean AND r->>'status' = 'pending' AND (r->>'hold_seconds')::int = 10, 'queued: ' || r::text;
  SELECT * INTO lane FROM wa_reaction_sync WHERE message_id = mid;
  ASSERT lane.desired_emoji = '👍' AND lane.applied_emoji = '' AND lane.hold_until > now() + interval '8 seconds', 'lane row: ' || row_to_json(lane)::text;
  r := wabridge_claim_reaction(ch);
  ASSERT NOT (r->>'claimed')::boolean AND r->>'reason' = 'nothing_to_send', 'held during the 10 s window: ' || r::text;

  -- 6. UNDO inside the hold: picking nothing → cancelled, never sent
  r := wabridge_queue_phone_reaction(mid, '👍', 'remove', staff1);
  ASSERT NOT (r->>'queued')::boolean AND r->>'reason' = 'unchanged', 'undo: ' || r::text;
  SELECT * INTO lane FROM wa_reaction_sync WHERE message_id = mid;
  ASSERT lane.status = 'cancelled' AND lane.desired_emoji = '', 'undo cancels: ' || row_to_json(lane)::text;
  r := wabridge_claim_reaction(ch);
  ASSERT NOT (r->>'claimed')::boolean, 'a cancelled pick is never claimed';

  -- 6b. UNDO of a replacement pick must NOT remove what is already on the phone (found in the browser): ❤️ is on the phone, 🔥 is picked, then un-picked
  PERFORM wabridge_queue_phone_reaction(mid, '❤️', 'set', staff1);
  UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second', claimed_at = now() - interval '1 minute' WHERE message_id = mid;
  r := wabridge_claim_reaction(ch);
  ASSERT (r->>'claimed')::boolean AND r->>'emoji' = '❤️', 'baseline ❤️ goes out: ' || r::text;
  PERFORM wabridge_finish_reaction(ch, (r->>'id')::uuid, true, NULL);
  PERFORM wabridge_queue_phone_reaction(mid, '🔥', 'set', staff1);
  ASSERT (SELECT desired_emoji FROM wa_reaction_sync WHERE message_id = mid) = '🔥' AND (SELECT applied_emoji FROM wa_reaction_sync WHERE message_id = mid) = '❤️', 'pending 🔥 over applied ❤️';
  r := wabridge_queue_phone_reaction(mid, '🔥', 'remove', staff1);
  ASSERT NOT (r->>'queued')::boolean AND r->>'reason' = 'unchanged', 'undo of the pending pick: ' || r::text;
  SELECT * INTO lane FROM wa_reaction_sync WHERE message_id = mid;
  ASSERT lane.status = 'cancelled' AND lane.desired_emoji = '❤️' AND lane.applied_emoji = '❤️', 'undo goes back to what the phone shows (does NOT remove it): ' || row_to_json(lane)::text;
  UPDATE wa_reaction_sync SET claimed_at = now() - interval '1 minute' WHERE message_id = mid;
  r := wabridge_claim_reaction(ch);
  ASSERT NOT (r->>'claimed')::boolean, 'nothing is sent after an undo';
  -- reset to a clean slate for the steps below
  DELETE FROM wa_reaction_sync WHERE message_id = mid;
  UPDATE messages SET reactions = (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(reactions) e WHERE e->>'reactor_type' <> 'line') WHERE id = mid;

  -- 7. re-pick, hold passes → the Mac claims it; the reader must be alive
  PERFORM wabridge_queue_phone_reaction(mid, '👍', 'set', staff1);
  UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second' WHERE message_id = mid;
  UPDATE wa_bridge_state SET reactions_seen_at = now() - interval '10 minutes' WHERE channel_id = ch;
  r := wabridge_claim_reaction(ch);
  ASSERT NOT (r->>'claimed')::boolean AND r->>'reason' = 'reader_stale', 'no sending while the phone→CRM reader is not alive: ' || r::text;
  UPDATE wa_bridge_state SET reactions_seen_at = now() WHERE channel_id = ch;
  r := wabridge_claim_reaction(ch);
  ASSERT (r->>'claimed')::boolean AND r->>'emoji' = '👍' AND r->>'external_message_id' = ext AND r->>'to_digits' = digits, 'claimed: ' || r::text;
  ASSERT (SELECT status FROM wa_reaction_sync WHERE message_id = mid) = 'sending', 'sending';
  r := wabridge_claim_reaction(ch);
  ASSERT r->>'reason' = 'in_flight', 'one at a time: ' || r::text;

  -- 8. the Mac reports success → the green 'phone' element appears; the team mark is untouched
  SELECT (wabridge_finish_reaction(ch, (SELECT id FROM wa_reaction_sync WHERE message_id = mid), true, NULL)) INTO r;
  ASSERT (r->>'ok')::boolean AND r->>'status' = 'sent', 'finish ok: ' || r::text;
  SELECT reactions INTO reacts FROM messages WHERE id = mid;
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(reacts) e WHERE e->>'reactor_type' = 'line' AND e->>'emoji' = '👍' AND e->>'source' = 'crm'), 'line element written: ' || reacts::text;
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(reacts) e WHERE e->>'reactor_type' = 'staff' AND e->>'emoji' = '🔥'), 'team mark untouched';
  ASSERT (SELECT applied_emoji FROM wa_reaction_sync WHERE message_id = mid) = '👍', 'applied recorded';
  r := wabridge_finish_reaction(ch, (SELECT id FROM wa_reaction_sync WHERE message_id = mid), true, NULL);
  ASSERT NOT (r->>'ok')::boolean AND r->>'code' = 'not_in_flight', 'a second finish is refused: ' || r::text;

  -- 9. the pacing gap: right after a send, the next claim waits
  PERFORM wabridge_queue_phone_reaction(mid, '❤️', 'set', staff1);
  UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second' WHERE message_id = mid;
  r := wabridge_claim_reaction(ch);
  ASSERT NOT (r->>'claimed')::boolean AND r->>'reason' = 'gap', 'gap: ' || r::text;
  UPDATE wa_reaction_sync SET claimed_at = now() - interval '1 minute' WHERE message_id = mid;

  -- 10. LATEST PICK WINS: ❤️ replaces 👍 on the phone — still exactly ONE 'line' element
  r := wabridge_claim_reaction(ch);
  ASSERT (r->>'claimed')::boolean AND r->>'emoji' = '❤️', 'replacement claimed: ' || r::text;
  PERFORM wabridge_finish_reaction(ch, (r->>'id')::uuid, true, NULL);
  SELECT reactions INTO reacts FROM messages WHERE id = mid;
  SELECT count(*) INTO line_count FROM jsonb_array_elements(reacts) e WHERE e->>'reactor_type' = 'line';
  ASSERT line_count = 1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(reacts) e WHERE e->>'reactor_type' = 'line' AND e->>'emoji' = '❤️'), 'one line element, now ❤️: ' || reacts::text;

  -- 11. un-picking an emoji that is NOT on the phone changes nothing; un-picking the one that is removes it (tombstone)
  r := wabridge_queue_phone_reaction(mid, '👍', 'remove', staff1);
  ASSERT NOT (r->>'queued')::boolean AND r->>'reason' = 'unchanged', 'not the one on the phone: ' || r::text;
  r := wabridge_queue_phone_reaction(mid, '❤️', 'remove', staff1);
  ASSERT (r->>'queued')::boolean, 'remove the one on the phone: ' || r::text;
  ASSERT (SELECT desired_emoji FROM wa_reaction_sync WHERE message_id = mid) = '', 'desired is none';
  UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second', claimed_at = now() - interval '1 minute' WHERE message_id = mid;
  r := wabridge_claim_reaction(ch);
  ASSERT (r->>'claimed')::boolean AND r->>'emoji' = '', 'removal claimed with an empty emoji: ' || r::text;
  PERFORM wabridge_finish_reaction(ch, (r->>'id')::uuid, true, NULL);
  SELECT reactions INTO reacts FROM messages WHERE id = mid;
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(reacts) e WHERE e->>'reactor_type' = 'line' AND e->>'emoji' = '' AND e->>'removed_at' IS NOT NULL AND e->>'source' = 'crm'), 'tombstone written: ' || reacts::text;
  ASSERT (SELECT status FROM wa_reaction_sync WHERE message_id = mid) = 'sent', 'removal recorded as sent';

  -- 12. the pick CHANGES while one is in flight: the in-flight one lands, the newer one follows after its own hold
  PERFORM wabridge_queue_phone_reaction(mid, '🙏', 'set', staff1);
  UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second', claimed_at = now() - interval '1 minute' WHERE message_id = mid;
  r := wabridge_claim_reaction(ch);
  ASSERT (r->>'claimed')::boolean AND r->>'emoji' = '🙏', '🙏 claimed';
  r := wabridge_queue_phone_reaction(mid, '👏', 'set', staff1);
  ASSERT (r->>'queued')::boolean, 'a newer pick while in flight is accepted: ' || r::text;
  ASSERT (SELECT status FROM wa_reaction_sync WHERE message_id = mid) = 'sending', 'still sending the first';
  r := wabridge_finish_reaction(ch, (SELECT id FROM wa_reaction_sync WHERE message_id = mid), true, NULL);
  ASSERT r->>'status' = 'pending', 'the newer pick re-queues: ' || r::text;
  SELECT * INTO lane FROM wa_reaction_sync WHERE message_id = mid;
  ASSERT lane.applied_emoji = '🙏' AND lane.desired_emoji = '👏', 'applied 🙏, desired 👏: ' || row_to_json(lane)::text;
  UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second', claimed_at = now() - interval '1 minute' WHERE message_id = mid;
  r := wabridge_claim_reaction(ch);
  ASSERT r->>'emoji' = '👏', 'then 👏 goes out: ' || r::text;

  -- 13. a failure is recorded with its reason and leaves the phone element alone; the next click tries again
  r := wabridge_finish_reaction(ch, (r->>'id')::uuid, false, 'the program said no');
  ASSERT r->>'status' = 'failed', 'failed: ' || r::text;
  ASSERT (SELECT error FROM wa_reaction_sync WHERE message_id = mid) = 'the program said no', 'reason kept';
  SELECT reactions INTO reacts FROM messages WHERE id = mid;
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(reacts) e WHERE e->>'reactor_type' = 'line' AND e->>'emoji' = '🙏'), 'phone element still 🙏 after a failed 👏';
  r := wabridge_queue_phone_reaction(mid, '👏', 'set', staff1);
  ASSERT (r->>'queued')::boolean AND (SELECT status FROM wa_reaction_sync WHERE message_id = mid) = 'pending' AND (SELECT attempts FROM wa_reaction_sync WHERE message_id = mid) = 0, 'a new click retries';

  -- 14. a claim the Mac never answered is retried (a reaction is idempotent), then failed after 3 attempts
  UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second', claimed_at = now() - interval '1 minute' WHERE message_id = mid;
  r := wabridge_claim_reaction(ch);
  ASSERT (r->>'claimed')::boolean, 'claimed for the lost-answer test';
  UPDATE wa_reaction_sync SET claimed_at = now() - interval '3 minutes' WHERE message_id = mid; -- the answer never came
  r := wabridge_claim_reaction(ch);
  ASSERT (r->>'claimed')::boolean AND (SELECT attempts FROM wa_reaction_sync WHERE message_id = mid) = 2, 'retried: ' || r::text;
  UPDATE wa_reaction_sync SET claimed_at = now() - interval '3 minutes', attempts = 3 WHERE message_id = mid;
  r := wabridge_claim_reaction(ch);
  ASSERT (SELECT status FROM wa_reaction_sync WHERE message_id = mid) = 'failed', 'failed after 3 attempts';

  -- 15. a reaction that waited more than 15 minutes expires (never a surprise reaction hours later)
  PERFORM wabridge_queue_phone_reaction(mid, '🎉', 'set', staff1);
  UPDATE wa_reaction_sync SET requested_at = now() - interval '20 minutes', hold_until = now() - interval '19 minutes', claimed_at = now() - interval '1 hour' WHERE message_id = mid;
  r := wabridge_claim_reaction(ch);
  ASSERT (SELECT status FROM wa_reaction_sync WHERE message_id = mid) = 'expired' AND NOT (r->>'claimed')::boolean, 'expired: ' || r::text;

  -- 16. the switch and the allowlist are re-checked at SEND time
  PERFORM wabridge_queue_phone_reaction(mid, '🔥', 'set', staff1);
  UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second', claimed_at = now() - interval '1 hour' WHERE message_id = mid;
  PERFORM wabridge_set_reactions_allowlist(ch, ARRAY['999000111222']);
  r := wabridge_claim_reaction(ch);
  ASSERT NOT (r->>'claimed')::boolean AND r->>'reason' = 'held', 'allowlist changed while waiting: ' || r::text;
  PERFORM wabridge_set_reactions_allowlist(ch, ARRAY[digits]);
  PERFORM wabridge_set_reactions_mode(ch, 'off');
  r := wabridge_claim_reaction(ch);
  ASSERT r->>'reason' = 'paused', 'switched off: ' || r::text;
  PERFORM wabridge_set_reactions_mode(ch, 'live');

  -- 17. caps: per chat per hour, then per hour
  UPDATE wa_bridge_state SET reactions_per_chat_hour = 1 WHERE channel_id = ch;
  UPDATE wa_reaction_sync SET claimed_at = now() - interval '30 minutes' WHERE message_id = mid; -- one claim in the last hour for this chat
  r := wabridge_claim_reaction(ch);
  ASSERT NOT (r->>'claimed')::boolean AND r->>'reason' = 'held', 'per-chat cap: ' || r::text;
  UPDATE wa_bridge_state SET reactions_per_chat_hour = 12, reactions_hourly_cap = 1 WHERE channel_id = ch;
  r := wabridge_claim_reaction(ch);
  ASSERT r->>'reason' = 'hourly_cap', 'hourly cap: ' || r::text;
  UPDATE wa_bridge_state SET reactions_hourly_cap = 40 WHERE channel_id = ch;

  -- 18. a phone-native 'line' reaction counts as what the phone shows: picking the same emoji is a no-op, another one is queued
  DELETE FROM wa_reaction_sync WHERE channel_id = ch;
  UPDATE messages SET reactions = jsonb_build_array(jsonb_build_object('emoji', '👍', 'reactor_id', 'wa-line', 'reactor_type', 'line', 'source', 'phone', 'scan_ms', 1, 'created_at', now())) WHERE id = mid;
  r := wabridge_queue_phone_reaction(mid, '👍', 'set', staff1);
  ASSERT NOT (r->>'queued')::boolean AND r->>'reason' = 'unchanged', 'same as the phone already shows: ' || r::text;
  r := wabridge_queue_phone_reaction(mid, '🙏', 'set', staff1);
  ASSERT (r->>'queued')::boolean AND (SELECT applied_emoji FROM wa_reaction_sync WHERE message_id = mid) = '👍', 'baseline taken from the phone element: ' || r::text;

  -- 19. a reaction never touches unread / last message time
  SELECT unread_count, last_message_at INTO after_unread, after_last FROM messaging_groups WHERE id = gid;
  ASSERT after_unread IS NOT DISTINCT FROM before_unread AND after_last IS NOT DISTINCT FROM before_last, 'unread and last_message_at unchanged';

  -- 20. nobody but the server can use any of it
  ASSERT NOT has_function_privilege('anon', 'wabridge_queue_phone_reaction(uuid,text,text,uuid)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'wabridge_claim_reaction(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'wabridge_finish_reaction(uuid,uuid,boolean,text)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'wabridge_set_reactions_mode(uuid,text,boolean)', 'EXECUTE')
     AND NOT has_table_privilege('authenticated', 'wa_reaction_sync', 'SELECT'), 'service role only';

  RAISE EXCEPTION 'ALL PASS';
END $$;
