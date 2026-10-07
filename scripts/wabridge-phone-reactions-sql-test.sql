-- Rule test for wabridge_apply_observed_reactions (phone → CRM reactions, dev job 5962e46d Release 1).
-- Runs against a real sandbox chat, rolls back via a deliberate RAISE EXCEPTION at the end. Expect "ALL PASS".
-- Usage: paste into the sandbox SQL editor / run through the sandbox execute_sql.
DO $$
DECLARE
  ch uuid;
  gid uuid;
  digits text;
  mid uuid;
  ext text := 'TESTREACT' || floor(random() * 1e9)::bigint::text;
  r jsonb;
  reacts jsonb;
  before_status text;
  before_unread int;
  before_last timestamptz;
  after_status text;
  after_unread int;
  after_last timestamptz;
  staff1 uuid := '11111111-1111-1111-1111-111111111111';
BEGIN
  SELECT id INTO ch FROM messaging_channels WHERE provider = 'wabridge' LIMIT 1;
  SELECT g.id, regexp_replace(g.external_group_id, '@.*$', '') INTO gid, digits
    FROM messaging_groups g
   WHERE g.channel_id = ch AND g.external_group_id ~ '^[0-9]{6,15}(@(s\.whatsapp\.net|c\.us))?$' LIMIT 1;
  ASSERT gid IS NOT NULL, 'sandbox needs one 1:1 chat on the wabridge channel';
  INSERT INTO messages (channel_id, group_id, direction, content_type, content_text, created_at, external_message_id)
  VALUES (ch, gid, 'outbound', 'text', 'reaction rule test', now(), ext)
  RETURNING id INTO mid;

  -- a healthy bridge for the removal tests (rolled back with everything else)
  UPDATE wa_bridge_state SET reachable = true, connected = true, logged_in = true, last_heartbeat_at = now() WHERE channel_id = ch;

  SELECT status INTO before_status FROM messages WHERE id = mid;
  SELECT unread_count, last_message_at INTO before_unread, before_last FROM messaging_groups WHERE id = gid;

  -- a CRM-only staff mark that must survive everything below
  PERFORM wabridge_toggle_reaction(mid, '🔥', staff1, 'Luca');

  -- 1. a client reaction is added
  r := wabridge_apply_observed_reactions(ch, jsonb_build_array(jsonb_build_object('ext_id', ext, 'chat', digits, 'side', 'client', 'op', 'set', 'emoji', '❤️', 'reacted_at', '2026-10-07T01:11:03Z')), 1000);
  ASSERT (r->>'ok')::boolean AND r->'results'->0->>'r' = 'applied', 'client add applies: ' || r::text;
  SELECT reactions INTO reacts FROM messages WHERE id = mid;
  ASSERT jsonb_array_length(reacts) = 2, 'staff mark + client reaction: ' || reacts::text;
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(reacts) e WHERE e->>'reactor_type' = 'staff' AND e->>'emoji' = '🔥'), 'staff mark untouched';
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(reacts) e WHERE e->>'reactor_type' = 'client' AND e->>'emoji' = '❤️' AND e->>'source' = 'phone'), 'client element stored';

  -- 2. same emoji again → no-op; a variation-selector difference alone is the same emoji
  r := wabridge_apply_observed_reactions(ch, jsonb_build_array(jsonb_build_object('ext_id', ext, 'chat', digits, 'side', 'client', 'op', 'set', 'emoji', '❤')), 1100);
  ASSERT r->'results'->0->>'r' = 'noop', 'same emoji (± variation selector) is a no-op: ' || r::text;

  -- 3. the client changes it → the SAME slot is updated in place (still 2 elements)
  r := wabridge_apply_observed_reactions(ch, jsonb_build_array(jsonb_build_object('ext_id', ext, 'chat', digits, 'side', 'client', 'op', 'set', 'emoji', '😂')), 1200);
  ASSERT r->'results'->0->>'r' = 'applied', 'change applies: ' || r::text;
  SELECT reactions INTO reacts FROM messages WHERE id = mid;
  ASSERT jsonb_array_length(reacts) = 2, 'one slot per side, updated in place: ' || reacts::text;
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(reacts) e WHERE e->>'reactor_type' = 'client' AND e->>'emoji' = '😂'), 'now 😂';

  -- 4. the business line reacts too: both sides coexist
  r := wabridge_apply_observed_reactions(ch, jsonb_build_array(jsonb_build_object('ext_id', ext, 'chat', digits, 'side', 'line', 'op', 'set', 'emoji', '👍')), 1300);
  SELECT reactions INTO reacts FROM messages WHERE id = mid;
  ASSERT jsonb_array_length(reacts) = 3, 'staff + client + line: ' || reacts::text;

  -- 5. an OLDER scan cannot override a newer decision
  r := wabridge_apply_observed_reactions(ch, jsonb_build_array(jsonb_build_object('ext_id', ext, 'chat', digits, 'side', 'client', 'op', 'set', 'emoji', '😮')), 1150);
  ASSERT r->'results'->0->>'r' = 'stale', 'older scan is stale: ' || r::text;

  -- 6. removal while healthy → tombstone (emoji '', scan_ms kept)
  r := wabridge_apply_observed_reactions(ch, jsonb_build_array(jsonb_build_object('ext_id', ext, 'chat', digits, 'side', 'client', 'op', 'remove')), 1400);
  ASSERT r->'results'->0->>'r' = 'applied', 'removal applies: ' || r::text;
  SELECT reactions INTO reacts FROM messages WHERE id = mid;
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(reacts) e WHERE e->>'reactor_type' = 'client' AND e->>'emoji' = '' AND (e->>'scan_ms')::bigint = 1400), 'tombstone written: ' || reacts::text;

  -- 7. a replayed OLDER add cannot resurrect the removed reaction
  r := wabridge_apply_observed_reactions(ch, jsonb_build_array(jsonb_build_object('ext_id', ext, 'chat', digits, 'side', 'client', 'op', 'set', 'emoji', '😂')), 1250);
  ASSERT r->'results'->0->>'r' = 'stale', 'replayed older add is stale: ' || r::text;

  -- 8. removing again is a no-op; a NEWER add after the removal works
  r := wabridge_apply_observed_reactions(ch, jsonb_build_array(jsonb_build_object('ext_id', ext, 'chat', digits, 'side', 'client', 'op', 'remove')), 1500);
  ASSERT r->'results'->0->>'r' = 'noop', 'second removal is a no-op: ' || r::text;
  r := wabridge_apply_observed_reactions(ch, jsonb_build_array(jsonb_build_object('ext_id', ext, 'chat', digits, 'side', 'client', 'op', 'set', 'emoji', '🙏')), 1600);
  ASSERT r->'results'->0->>'r' = 'applied', 'a newer add after the removal applies: ' || r::text;

  -- 9. removal while the bridge is NOT healthy is HELD, nothing removed
  UPDATE wa_bridge_state SET last_heartbeat_at = now() - interval '10 minutes' WHERE channel_id = ch;
  r := wabridge_apply_observed_reactions(ch, jsonb_build_array(jsonb_build_object('ext_id', ext, 'chat', digits, 'side', 'line', 'op', 'remove')), 1700);
  ASSERT r->'results'->0->>'r' = 'held', 'removal held while unhealthy: ' || r::text;
  SELECT reactions INTO reacts FROM messages WHERE id = mid;
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(reacts) e WHERE e->>'reactor_type' = 'line' AND e->>'emoji' = '👍'), 'line reaction still there';
  UPDATE wa_bridge_state SET last_heartbeat_at = now() WHERE channel_id = ch;

  -- 10. unknown message / wrong chat → unmatched; bad shapes → invalid
  r := wabridge_apply_observed_reactions(ch, jsonb_build_array(
    jsonb_build_object('ext_id', 'NOSUCHMESSAGE1', 'chat', digits, 'side', 'client', 'op', 'set', 'emoji', '👍'),
    jsonb_build_object('ext_id', ext, 'chat', '999999999999', 'side', 'client', 'op', 'set', 'emoji', '👍'),
    jsonb_build_object('ext_id', ext, 'chat', digits, 'side', 'bogus', 'op', 'set', 'emoji', '👍'),
    jsonb_build_object('ext_id', ext, 'chat', digits, 'side', 'client', 'op', 'set', 'emoji', 'abc'),
    jsonb_build_object('ext_id', ext, 'chat', digits, 'side', 'client', 'op', 'set', 'emoji', ''),
    jsonb_build_object('ext_id', ext, 'chat', digits, 'side', 'client', 'op', 'set', 'emoji', '1️⃣')
  ), 1800);
  ASSERT r->'results'->0->>'r' = 'unmatched', 'unknown message: ' || r::text;
  ASSERT r->'results'->1->>'r' = 'unmatched', 'wrong chat digits: ' || r::text;
  ASSERT r->'results'->2->>'r' = 'invalid', 'bad side: ' || r::text;
  ASSERT r->'results'->3->>'r' = 'invalid', 'plain letters are not an emoji: ' || r::text;
  ASSERT r->'results'->4->>'r' = 'invalid', 'empty emoji on a set: ' || r::text;
  ASSERT r->'results'->5->>'r' IN ('applied', 'noop'), 'a keycap emoji (contains a digit) is accepted: ' || r::text;

  -- 11. the beat is recorded even for an empty batch; the whole-batch refusals
  UPDATE wa_bridge_state SET reactions_seen_at = NULL WHERE channel_id = ch;
  r := wabridge_apply_observed_reactions(ch, '[]'::jsonb, 1900);
  ASSERT (r->>'ok')::boolean, 'empty batch ok';
  ASSERT (SELECT reactions_seen_at FROM wa_bridge_state WHERE channel_id = ch) IS NOT NULL, 'beat recorded';
  r := wabridge_apply_observed_reactions(ch, '{}'::jsonb, 1900);
  ASSERT r->>'code' = 'bad_items', 'object instead of array refused: ' || r::text;
  r := wabridge_apply_observed_reactions(ch, '[]'::jsonb, 0);
  ASSERT r->>'code' = 'bad_scan', 'bad scan time refused: ' || r::text;

  -- 12. a reaction never touches status, unread or last_message_at
  SELECT status INTO after_status FROM messages WHERE id = mid;
  SELECT unread_count, last_message_at INTO after_unread, after_last FROM messaging_groups WHERE id = gid;
  ASSERT after_status IS NOT DISTINCT FROM before_status, 'message status unchanged';
  ASSERT after_unread IS NOT DISTINCT FROM before_unread, 'unread count unchanged';
  ASSERT after_last IS NOT DISTINCT FROM before_last, 'last_message_at unchanged';

  -- 13. nobody but the service role can call it
  ASSERT NOT has_function_privilege('anon', 'wabridge_apply_observed_reactions(uuid,jsonb,bigint)', 'execute'), 'anon locked out';
  ASSERT NOT has_function_privilege('authenticated', 'wabridge_apply_observed_reactions(uuid,jsonb,bigint)', 'execute'), 'authenticated locked out';

  RAISE EXCEPTION 'ALL PASS';
END $$;
