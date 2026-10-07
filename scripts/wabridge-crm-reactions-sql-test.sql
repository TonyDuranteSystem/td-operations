-- Rule test for the CRM → phone reaction lane (dev job 5962e46d, Release 2): wabridge_react_click / queue / claim / finish / switches.
-- Runs against a real sandbox chat, rolls back via a deliberate RAISE EXCEPTION at the end. Expect "ALL PASS".
DO $$
DECLARE
  ch uuid;
  gid uuid;
  digits text;
  mid uuid;
  mid_old uuid;
  inbound_ids uuid[];
  ext text := 'TESTRXN' || floor(random() * 1e9)::bigint::text;
  ext_old text := 'TESTOLD' || floor(random() * 1e9)::bigint::text;
  r jsonb;
  c jsonb;
  reacts jsonb;
  lane record;
  staff1 uuid := '11111111-1111-1111-1111-111111111111';
  before_unread int;
  before_last timestamptz;
  after_unread int;
  after_last timestamptz;
  line_count int;
  mac_ts bigint := 1791400000123;
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

  -- a healthy bridge with a live reader AND a live reaction sender (rolled back with everything else); switch OFF, nobody allowed
  UPDATE wa_bridge_state SET reachable = true, connected = true, logged_in = true, last_heartbeat_at = now(), reactions_seen_at = now(), reactions_sender_seen_at = now(),
         reactions_mode = 'off', reactions_allowlist = '{}', reactions_allow_all = false,
         reactions_min_gap_seconds = 4, reactions_hourly_cap = 40, reactions_daily_cap = 200, reactions_per_chat_hour = 12
   WHERE channel_id = ch;
  DELETE FROM wa_reaction_sync WHERE channel_id = ch;
  DELETE FROM wa_reaction_sends WHERE channel_id = ch;
  PERFORM wabridge_toggle_reaction(mid, '🧡', staff1, 'Luca'); -- a CRM-only team mark that must survive everything

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
  UPDATE wa_bridge_state SET reactions_sender_seen_at = now() - interval '10 minutes' WHERE channel_id = ch;
  r := wabridge_queue_phone_reaction(mid, '👍', 'set', staff1);
  ASSERT r->>'reason' = 'sender_offline', 'the Mac reaction sender is not running: ' || r::text;
  UPDATE wa_bridge_state SET reactions_sender_seen_at = now() WHERE channel_id = ch;
  UPDATE messaging_groups SET external_group_id = external_group_id || '@g.us' WHERE id = gid;
  r := wabridge_queue_phone_reaction(mid, '👍', 'set', staff1);
  ASSERT r->>'reason' = 'not_one_to_one', 'a group chat: ' || r::text;
  UPDATE messaging_groups SET external_group_id = replace(external_group_id, '@g.us', '') WHERE id = gid;
  -- REPLIES ONLY (council): a chat where the person has never written gets no reaction
  SELECT array_agg(id) INTO inbound_ids FROM messages WHERE group_id = gid AND direction = 'inbound';
  UPDATE messages SET direction = 'outbound' WHERE id = ANY (inbound_ids);
  r := wabridge_queue_phone_reaction(mid, '👍', 'set', staff1);
  ASSERT r->>'reason' = 'no_inbound', 'replies only: ' || r::text;
  UPDATE messages SET direction = 'inbound' WHERE id = ANY (inbound_ids);
  r := wabridge_queue_phone_reaction(gen_random_uuid(), '👍', 'set', staff1);
  ASSERT NOT (r->>'ok')::boolean AND r->>'code' = 'not_found', 'unknown message';
  r := wabridge_queue_phone_reaction(mid, '👍', 'sideways', staff1);
  ASSERT r->>'code' = 'bad_request', 'bad action';
  ASSERT NOT EXISTS (SELECT 1 FROM wa_reaction_sync WHERE channel_id = ch), 'every refusal left no lane row';

  -- 5. a pick is queued, then HELD 3 s (undo window; was 10 s until 20261007-2100): nothing to claim yet. The heart is stored with its variation selector.
  r := wabridge_queue_phone_reaction(mid, '❤', 'set', staff1);
  ASSERT (r->>'queued')::boolean AND r->>'status' = 'pending' AND (r->>'hold_seconds')::int = 3, 'queued: ' || r::text;
  SELECT * INTO lane FROM wa_reaction_sync WHERE message_id = mid;
  ASSERT lane.desired_emoji = '❤️' AND lane.applied_emoji = '' AND lane.hold_until > now() + interval '1 second' AND lane.hold_until <= now() + interval '4 seconds', 'lane row (heart canonical): ' || row_to_json(lane)::text;
  r := wabridge_claim_reaction(ch);
  ASSERT NOT (r->>'claimed')::boolean AND r->>'reason' = 'nothing_to_send', 'held during the 3 s window: ' || r::text;

  -- 6. UNDO inside the hold: picking nothing → cancelled, never sent
  r := wabridge_queue_phone_reaction(mid, '❤️', 'remove', staff1);
  ASSERT NOT (r->>'queued')::boolean AND r->>'reason' = 'unchanged', 'undo: ' || r::text;
  SELECT * INTO lane FROM wa_reaction_sync WHERE message_id = mid;
  ASSERT lane.status = 'cancelled' AND lane.desired_emoji = '', 'undo cancels: ' || row_to_json(lane)::text;
  ASSERT NOT (wabridge_claim_reaction(ch)->>'claimed')::boolean, 'a cancelled pick is never claimed';

  -- 6b. the undo window is a SETTING (reactions_hold_seconds): too big is clamped to 30, negative to 0 (= instant), and the answer carries the value used
  UPDATE wa_bridge_state SET reactions_hold_seconds = 99 WHERE channel_id = ch;
  r := wabridge_queue_phone_reaction(mid, '👍', 'set', staff1);
  ASSERT (r->>'queued')::boolean AND (r->>'hold_seconds')::int = 30, 'hold clamped to 30: ' || r::text;
  PERFORM wabridge_queue_phone_reaction(mid, '👍', 'remove', staff1); -- undo it again
  UPDATE wa_bridge_state SET reactions_hold_seconds = -5 WHERE channel_id = ch;
  r := wabridge_queue_phone_reaction(mid, '👍', 'set', staff1);
  SELECT * INTO lane FROM wa_reaction_sync WHERE message_id = mid;
  ASSERT (r->>'queued')::boolean AND (r->>'hold_seconds')::int = 0 AND lane.hold_until <= now() + interval '1 second', 'hold clamped to 0 (instant): ' || r::text;
  PERFORM wabridge_queue_phone_reaction(mid, '👍', 'remove', staff1); -- undo it again
  UPDATE wa_bridge_state SET reactions_hold_seconds = 3 WHERE channel_id = ch; -- back to the default
  SELECT * INTO lane FROM wa_reaction_sync WHERE message_id = mid;
  ASSERT lane.status = 'cancelled', 'the tuning checks left the lane cancelled: ' || row_to_json(lane)::text;

  -- 7. re-pick, hold passes → the Mac claims it; the reader must be alive
  PERFORM wabridge_queue_phone_reaction(mid, '👍', 'set', staff1);
  UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second' WHERE message_id = mid;
  UPDATE wa_bridge_state SET reactions_seen_at = now() - interval '10 minutes' WHERE channel_id = ch;
  r := wabridge_claim_reaction(ch);
  ASSERT NOT (r->>'claimed')::boolean AND r->>'reason' = 'reader_stale', 'no sending while the phone→CRM reader is not alive: ' || r::text;
  UPDATE wa_bridge_state SET reactions_seen_at = now() WHERE channel_id = ch;
  c := wabridge_claim_reaction(ch);
  ASSERT (c->>'claimed')::boolean AND c->>'emoji' = '👍' AND c->>'external_message_id' = ext AND c->>'to_digits' = digits AND (c->>'attempt')::int = 1, 'claimed: ' || c::text;
  ASSERT (SELECT status FROM wa_reaction_sync WHERE message_id = mid) = 'sending', 'sending';
  r := wabridge_claim_reaction(ch);
  ASSERT r->>'reason' = 'in_flight', 'one at a time: ' || r::text;

  -- 8. the Mac reports success → the green 'phone' element appears (Mac clock in scan_ms); the team mark is untouched
  r := wabridge_finish_reaction(ch, (c->>'id')::uuid, true, NULL, 1, mac_ts);
  ASSERT (r->>'ok')::boolean AND r->>'status' = 'sent', 'finish ok: ' || r::text;
  SELECT reactions INTO reacts FROM messages WHERE id = mid;
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(reacts) e WHERE e->>'reactor_type' = 'line' AND e->>'emoji' = '👍' AND e->>'source' = 'crm' AND (e->>'scan_ms')::bigint = mac_ts), 'line element written with the Mac clock: ' || reacts::text;
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(reacts) e WHERE e->>'reactor_type' = 'staff' AND e->>'emoji' = '🧡'), 'team mark untouched';
  r := wabridge_finish_reaction(ch, (c->>'id')::uuid, true, NULL, 1, mac_ts);
  ASSERT NOT (r->>'ok')::boolean AND r->>'code' = 'not_in_flight', 'a second finish is refused: ' || r::text;

  -- 9. the pacing gap: right after a send, the next claim waits
  PERFORM wabridge_queue_phone_reaction(mid, '😂', 'set', staff1);
  UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second' WHERE message_id = mid;
  r := wabridge_claim_reaction(ch);
  ASSERT NOT (r->>'claimed')::boolean AND r->>'reason' = 'gap', 'gap: ' || r::text;
  UPDATE wa_reaction_sends SET claimed_at = now() - interval '1 minute' WHERE channel_id = ch;

  -- 10. LATEST PICK WINS: 😂 replaces 👍 on the phone — still exactly ONE 'line' element
  c := wabridge_claim_reaction(ch);
  ASSERT (c->>'claimed')::boolean AND c->>'emoji' = '😂', 'replacement claimed: ' || c::text;
  PERFORM wabridge_finish_reaction(ch, (c->>'id')::uuid, true, NULL, (c->>'attempt')::int, mac_ts + 1000);
  SELECT reactions INTO reacts FROM messages WHERE id = mid;
  SELECT count(*) INTO line_count FROM jsonb_array_elements(reacts) e WHERE e->>'reactor_type' = 'line';
  ASSERT line_count = 1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(reacts) e WHERE e->>'reactor_type' = 'line' AND e->>'emoji' = '😂'), 'one line element, now 😂: ' || reacts::text;

  -- 11. un-picking an emoji that is NOT on the phone changes nothing; un-picking the one that is removes it (removal marker)
  r := wabridge_queue_phone_reaction(mid, '👍', 'remove', staff1);
  ASSERT NOT (r->>'queued')::boolean AND r->>'reason' = 'unchanged', 'not the one on the phone: ' || r::text;
  r := wabridge_queue_phone_reaction(mid, '😂', 'remove', staff1);
  ASSERT (r->>'queued')::boolean, 'remove the one on the phone: ' || r::text;
  ASSERT (SELECT desired_emoji FROM wa_reaction_sync WHERE message_id = mid) = '', 'desired is none';
  UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second' WHERE message_id = mid;
  UPDATE wa_reaction_sends SET claimed_at = now() - interval '1 minute' WHERE channel_id = ch;
  c := wabridge_claim_reaction(ch);
  ASSERT (c->>'claimed')::boolean AND c->>'emoji' = '', 'removal claimed with an empty emoji: ' || c::text;
  PERFORM wabridge_finish_reaction(ch, (c->>'id')::uuid, true, NULL, (c->>'attempt')::int, mac_ts + 2000);
  SELECT reactions INTO reacts FROM messages WHERE id = mid;
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(reacts) e WHERE e->>'reactor_type' = 'line' AND e->>'emoji' = '' AND e->>'removed_at' IS NOT NULL AND e->>'source' = 'crm'), 'removal marker written: ' || reacts::text;
  ASSERT (SELECT status FROM wa_reaction_sync WHERE message_id = mid) = 'sent', 'removal recorded as sent';

  -- 12. UNDO of a replacement pick must NOT remove what is already on the phone (found in the browser)
  PERFORM wabridge_queue_phone_reaction(mid, '🙏', 'set', staff1);
  UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second' WHERE message_id = mid;
  UPDATE wa_reaction_sends SET claimed_at = now() - interval '1 minute' WHERE channel_id = ch;
  c := wabridge_claim_reaction(ch);
  PERFORM wabridge_finish_reaction(ch, (c->>'id')::uuid, true, NULL, (c->>'attempt')::int, mac_ts + 3000);
  PERFORM wabridge_queue_phone_reaction(mid, '🔥', 'set', staff1);
  ASSERT (SELECT desired_emoji FROM wa_reaction_sync WHERE message_id = mid) = '🔥', 'pending 🔥 over 🙏 on the phone';
  r := wabridge_queue_phone_reaction(mid, '🔥', 'remove', staff1);
  ASSERT NOT (r->>'queued')::boolean AND r->>'reason' = 'unchanged', 'undo of the pending pick: ' || r::text;
  SELECT * INTO lane FROM wa_reaction_sync WHERE message_id = mid;
  ASSERT lane.status = 'cancelled' AND lane.desired_emoji = '🙏', 'undo goes back to what the phone shows (does NOT remove it): ' || row_to_json(lane)::text;
  UPDATE wa_reaction_sends SET claimed_at = now() - interval '1 minute' WHERE channel_id = ch;
  ASSERT NOT (wabridge_claim_reaction(ch)->>'claimed')::boolean, 'nothing is sent after an undo';

  -- 13. THE 'line' ELEMENT IS THE TRUTH (council): the owner changes the reaction natively on the phone; the reader updates the element
  UPDATE messages SET reactions = (SELECT jsonb_agg(CASE WHEN e->>'reactor_type' = 'line' THEN e || jsonb_build_object('emoji', '🎉', 'source', 'phone', 'scan_ms', mac_ts + 9000) ELSE e END) FROM jsonb_array_elements(reactions) e) WHERE id = mid;
  r := wabridge_queue_phone_reaction(mid, '🙏', 'set', staff1);
  ASSERT (r->>'queued')::boolean, 'a pick of what the CRM last sent is NOT "unchanged" when the phone now shows something else: ' || r::text;
  UPDATE wa_reaction_sync SET status = 'cancelled' WHERE message_id = mid; -- reset
  r := wabridge_queue_phone_reaction(mid, '🙏', 'remove', staff1);
  ASSERT NOT (r->>'queued')::boolean AND r->>'reason' = 'unchanged', 'un-picking something that is not on the phone never removes the owner''s own reaction: ' || r::text;
  UPDATE messages SET reactions = (SELECT jsonb_agg(CASE WHEN e->>'reactor_type' = 'line' THEN e || jsonb_build_object('emoji', '🙏', 'source', 'crm') ELSE e END) FROM jsonb_array_elements(reactions) e) WHERE id = mid;
  DELETE FROM wa_reaction_sync WHERE message_id = mid;

  -- 14. a failure is recorded with its reason and leaves the phone element alone; picking the SAME emoji again retries it (council)
  PERFORM wabridge_queue_phone_reaction(mid, '👏', 'set', staff1);
  UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second' WHERE message_id = mid;
  UPDATE wa_reaction_sends SET claimed_at = now() - interval '1 minute' WHERE channel_id = ch;
  c := wabridge_claim_reaction(ch);
  r := wabridge_finish_reaction(ch, (c->>'id')::uuid, false, 'the program said no', (c->>'attempt')::int, mac_ts + 4000);
  ASSERT r->>'status' = 'failed', 'failed: ' || r::text;
  ASSERT (SELECT error FROM wa_reaction_sync WHERE message_id = mid) = 'the program said no', 'reason kept';
  SELECT reactions INTO reacts FROM messages WHERE id = mid;
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(reacts) e WHERE e->>'reactor_type' = 'line' AND e->>'emoji' = '🙏'), 'phone element still 🙏 after a failed 👏';
  r := wabridge_queue_phone_reaction(mid, '👏', 'set', staff1);
  ASSERT (r->>'queued')::boolean AND (SELECT status FROM wa_reaction_sync WHERE message_id = mid) = 'pending' AND (SELECT attempts FROM wa_reaction_sync WHERE message_id = mid) = 0, 'picking it again retries: ' || r::text;
  -- …and a pick that makes the phone consistent again clears the red error
  PERFORM wabridge_queue_phone_reaction(mid, '🙏', 'set', staff1);
  SELECT * INTO lane FROM wa_reaction_sync WHERE message_id = mid;
  ASSERT lane.status = 'cancelled' AND lane.error IS NULL, 'back to what the phone shows → cancelled, no stale error: ' || row_to_json(lane)::text;

  -- 15. a pick that changed WHILE one was in flight is not lost when the in-flight one FAILS (council)
  PERFORM wabridge_queue_phone_reaction(mid, '🔥', 'set', staff1);
  UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second' WHERE message_id = mid;
  UPDATE wa_reaction_sends SET claimed_at = now() - interval '1 minute' WHERE channel_id = ch;
  c := wabridge_claim_reaction(ch);
  ASSERT c->>'emoji' = '🔥', '🔥 in flight';
  r := wabridge_queue_phone_reaction(mid, '🎉', 'set', staff1);
  ASSERT (r->>'queued')::boolean AND (SELECT status FROM wa_reaction_sync WHERE message_id = mid) = 'sending', 'newer pick accepted mid-flight';
  r := wabridge_finish_reaction(ch, (c->>'id')::uuid, false, 'boom', (c->>'attempt')::int, mac_ts + 5000);
  ASSERT r->>'status' = 'pending', 'the newer pick survives the failure of the old one: ' || r::text;
  SELECT * INTO lane FROM wa_reaction_sync WHERE message_id = mid;
  ASSERT lane.desired_emoji = '🎉' AND lane.error IS NULL, 'desired 🎉, no error shown: ' || row_to_json(lane)::text;
  -- …and a success of the old one re-queues the newer one with the phone element updated
  UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second' WHERE message_id = mid;
  UPDATE wa_reaction_sends SET claimed_at = now() - interval '1 minute' WHERE channel_id = ch;
  c := wabridge_claim_reaction(ch);
  ASSERT c->>'emoji' = '🎉', '🎉 goes out';
  PERFORM wabridge_queue_phone_reaction(mid, '👏', 'set', staff1);
  r := wabridge_finish_reaction(ch, (c->>'id')::uuid, true, NULL, (c->>'attempt')::int, mac_ts + 6000);
  ASSERT r->>'status' = 'pending', 'success of the old pick re-queues the newer: ' || r::text;
  ASSERT (SELECT applied_emoji FROM wa_reaction_sync WHERE message_id = mid) = '🎉' AND wabridge_react_line_emoji((SELECT reactions FROM messages WHERE id = mid)) = '🎉', 'phone element is 🎉 now';

  -- 16. a claim the Mac never answered is retried; an answer for an OLDER claim is refused (claim number); 3 attempts then failed
  UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second' WHERE message_id = mid;
  UPDATE wa_reaction_sends SET claimed_at = now() - interval '1 minute' WHERE channel_id = ch;
  c := wabridge_claim_reaction(ch);
  ASSERT (c->>'claimed')::boolean AND (c->>'attempt')::int = 1, 'attempt 1';
  UPDATE wa_reaction_sync SET claimed_at = now() - interval '3 minutes' WHERE message_id = mid; -- the answer never came
  UPDATE wa_reaction_sends SET claimed_at = now() - interval '5 minutes' WHERE channel_id = ch;
  r := wabridge_claim_reaction(ch);
  ASSERT (r->>'claimed')::boolean AND (r->>'attempt')::int = 2, 'retried as attempt 2: ' || r::text;
  r := wabridge_finish_reaction(ch, (c->>'id')::uuid, true, NULL, 1, mac_ts + 7000);
  ASSERT NOT (r->>'ok')::boolean AND r->>'code' = 'stale_claim', 'the late answer to attempt 1 is refused: ' || r::text;
  ASSERT (SELECT status FROM wa_reaction_sync WHERE message_id = mid) = 'sending', 'still waiting for attempt 2';
  UPDATE wa_reaction_sync SET claimed_at = now() - interval '3 minutes', attempts = 3 WHERE message_id = mid;
  PERFORM wabridge_claim_reaction(ch);
  SELECT * INTO lane FROM wa_reaction_sync WHERE message_id = mid;
  ASSERT lane.status = 'failed' AND lane.error ~ 'may or may not', 'failed after 3 attempts, honest wording: ' || row_to_json(lane)::text;

  -- 17. housekeeping runs even while PAUSED; a reaction that waited more than 15 minutes expires
  PERFORM wabridge_queue_phone_reaction(mid, '👏', 'set', staff1);
  UPDATE wa_reaction_sync SET requested_at = now() - interval '20 minutes', hold_until = now() - interval '19 minutes' WHERE message_id = mid;
  PERFORM wabridge_set_reactions_mode(ch, 'off');
  r := wabridge_claim_reaction(ch);
  ASSERT r->>'reason' = 'paused', 'paused: ' || r::text;
  ASSERT (SELECT status FROM wa_reaction_sync WHERE message_id = mid) = 'expired', 'expired even while paused';
  PERFORM wabridge_set_reactions_mode(ch, 'live');
  -- finished rows older than 30 days are purged
  INSERT INTO wa_reaction_sync (channel_id, group_id, message_id, external_message_id, to_digits, status, finished_at, requested_at)
  VALUES (ch, gid, mid_old, ext_old, digits, 'sent', now() - interval '40 days', now() - interval '40 days');
  INSERT INTO wa_reaction_sends (channel_id, group_id, claimed_at) VALUES (ch, gid, now() - interval '40 days');
  PERFORM wabridge_claim_reaction(ch);
  ASSERT NOT EXISTS (SELECT 1 FROM wa_reaction_sync WHERE message_id = mid_old), 'old finished lane purged';
  ASSERT NOT EXISTS (SELECT 1 FROM wa_reaction_sends WHERE channel_id = ch AND claimed_at < now() - interval '30 days'), 'old send log purged';

  -- 18. the switch and the allowlist and the chat are re-checked at SEND time
  DELETE FROM wa_reaction_sync WHERE message_id = mid;
  PERFORM wabridge_queue_phone_reaction(mid, '🔥', 'set', staff1);
  UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second' WHERE message_id = mid;
  UPDATE wa_reaction_sends SET claimed_at = now() - interval '1 hour' WHERE channel_id = ch;
  PERFORM wabridge_set_reactions_allowlist(ch, ARRAY['999000111222']);
  r := wabridge_claim_reaction(ch);
  ASSERT NOT (r->>'claimed')::boolean AND r->>'reason' = 'held', 'allowlist changed while waiting: ' || r::text;
  PERFORM wabridge_set_reactions_allowlist(ch, ARRAY[digits]);
  UPDATE messages SET direction = 'outbound' WHERE id = ANY (inbound_ids);
  r := wabridge_claim_reaction(ch);
  ASSERT NOT (r->>'claimed')::boolean AND (SELECT status FROM wa_reaction_sync WHERE message_id = mid) = 'cancelled', 'replies-only re-checked at send time';
  UPDATE messages SET direction = 'inbound' WHERE id = ANY (inbound_ids);
  PERFORM wabridge_queue_phone_reaction(mid, '🔥', 'set', staff1);
  UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second' WHERE message_id = mid;
  UPDATE messages SET deleted_at = now() WHERE id = mid;
  r := wabridge_claim_reaction(ch);
  ASSERT NOT (r->>'claimed')::boolean AND (SELECT status FROM wa_reaction_sync WHERE message_id = mid) = 'cancelled', 'a hidden message is not reacted to';
  UPDATE messages SET deleted_at = NULL WHERE id = mid;

  -- 19. CAPS COUNT ACTUAL SENDS, not lane rows (council): one message re-picked again and again still trips the hourly cap
  DELETE FROM wa_reaction_sync WHERE message_id = mid;
  DELETE FROM wa_reaction_sends WHERE channel_id = ch;
  UPDATE wa_bridge_state SET reactions_hourly_cap = 3, reactions_min_gap_seconds = 2 WHERE channel_id = ch;
  FOR line_count IN 1 .. 3 LOOP
    PERFORM wabridge_queue_phone_reaction(mid, CASE line_count WHEN 1 THEN '👍' WHEN 2 THEN '😂' ELSE '🎉' END, 'set', staff1);
    UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second' WHERE message_id = mid;
    UPDATE wa_reaction_sends SET claimed_at = claimed_at - interval '1 minute' WHERE channel_id = ch;
    c := wabridge_claim_reaction(ch);
    ASSERT (c->>'claimed')::boolean, 'send ' || line_count || ' goes out: ' || c::text;
    PERFORM wabridge_finish_reaction(ch, (c->>'id')::uuid, true, NULL, (c->>'attempt')::int, mac_ts + 10000 + line_count);
  END LOOP;
  PERFORM wabridge_queue_phone_reaction(mid, '🔥', 'set', staff1);
  UPDATE wa_reaction_sync SET hold_until = now() - interval '1 second' WHERE message_id = mid;
  UPDATE wa_reaction_sends SET claimed_at = claimed_at - interval '1 minute' WHERE channel_id = ch;
  r := wabridge_claim_reaction(ch);
  ASSERT NOT (r->>'claimed')::boolean AND r->>'reason' = 'hourly_cap', 'the 4th send of ONE message in an hour is capped: ' || r::text;
  ASSERT (SELECT count(*) FROM wa_reaction_sends WHERE channel_id = ch) = 3, 'the log holds one row per actual send';
  UPDATE wa_bridge_state SET reactions_hourly_cap = 40, reactions_per_chat_hour = 3 WHERE channel_id = ch;
  r := wabridge_claim_reaction(ch);
  ASSERT NOT (r->>'claimed')::boolean AND r->>'reason' = 'held', 'per-chat cap: ' || r::text;
  UPDATE wa_bridge_state SET reactions_per_chat_hour = 12 WHERE channel_id = ch;

  -- 20. taking a reaction OFF is exempt from the 1-hour limit; putting one ON is not
  UPDATE messages SET reactions = jsonb_build_array(jsonb_build_object('emoji', '👍', 'reactor_id', 'wa-line', 'reactor_type', 'line', 'source', 'crm', 'scan_ms', 1, 'created_at', now())) WHERE id = mid_old;
  r := wabridge_queue_phone_reaction(mid_old, '👍', 'remove', staff1);
  ASSERT (r->>'queued')::boolean, 'removal of a reaction on an old message is allowed: ' || r::text;
  r := wabridge_queue_phone_reaction(mid_old, '😂', 'set', staff1);
  ASSERT r->>'reason' = 'too_old', 'putting one on an old message is not';
  DELETE FROM wa_reaction_sync WHERE message_id = mid_old;

  -- 21. the click is ONE transaction: the team mark and the phone decision always agree
  DELETE FROM wa_reaction_sync WHERE message_id = mid;
  UPDATE messages SET reactions = '[]'::jsonb WHERE id = mid;
  r := wabridge_react_click(mid, '👍', staff1, 'Luca');
  ASSERT (r->'toggle'->>'added')::boolean AND (r->'phone'->>'queued')::boolean, 'click 1: pick → team mark added AND queued: ' || r::text;
  r := wabridge_react_click(mid, '👍', staff1, 'Luca');
  ASSERT NOT (r->'toggle'->>'added')::boolean AND NOT (r->'phone'->>'queued')::boolean AND r->'phone'->>'reason' = 'unchanged', 'click 2: un-pick → mark removed, pick undone before it went out: ' || r::text;
  ASSERT (SELECT status FROM wa_reaction_sync WHERE message_id = mid) = 'cancelled', 'cancelled';
  r := wabridge_react_click(gen_random_uuid(), '👍', staff1, 'Luca');
  ASSERT NOT (r->'toggle'->>'ok')::boolean AND r->'phone' = 'null'::jsonb, 'unknown message: ' || r::text;

  -- 22. a reaction never touches unread / last message time
  SELECT unread_count, last_message_at INTO after_unread, after_last FROM messaging_groups WHERE id = gid;
  ASSERT after_unread IS NOT DISTINCT FROM before_unread AND after_last IS NOT DISTINCT FROM before_last, 'unread and last_message_at unchanged';

  -- 23. nobody but the server can use any of it
  ASSERT NOT has_function_privilege('anon', 'wabridge_queue_phone_reaction(uuid,text,text,uuid)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'wabridge_react_click(uuid,text,uuid,text)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'wabridge_claim_reaction(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'wabridge_finish_reaction(uuid,uuid,boolean,text,integer,bigint)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'wabridge_set_reactions_mode(uuid,text,boolean)', 'EXECUTE')
     AND NOT has_table_privilege('authenticated', 'wa_reaction_sync', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'wa_reaction_sends', 'SELECT'), 'service role only';

  RAISE EXCEPTION 'ALL PASS';
END $$;
