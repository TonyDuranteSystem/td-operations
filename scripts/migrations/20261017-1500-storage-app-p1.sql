-- Storage Mac app, phase P1 (dev job 1992a087): the download limit, atomic. SANDBOX first (R105). UNDO: 20261017-1500-storage-app-p1.UNDO.sql
--
-- storage_app_reserve_read(...) is the ONLY way a signed download link is allowed: in ONE transaction, under a lock per person, it adds up
-- what this Mac AND this person (all their Macs together) opened in the last hour, refuses when the new file does not fit, and otherwise
-- writes the audit row (`app_file_opened`) — so parallel requests cannot all pass the check before any of them is counted, and a failed
-- audit write means NO link (fail closed). A refusal writes ONE `app_download_limit_hit` row per Mac per 10 minutes (Finder retries must
-- not flood the audit log). A file with no recorded size counts as 1 MB (never zero).
CREATE OR REPLACE FUNCTION public.storage_app_reserve_read(
  p_device uuid, p_user uuid, p_owner uuid, p_file uuid, p_name text, p_size bigint,
  p_device_limit bigint, p_user_limit bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  cost bigint := GREATEST(COALESCE(p_size, 0), 1048576);
  used_device bigint; used_user bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('storage_app_read:' || p_user::text, 0));
  SELECT COALESCE(SUM(GREATEST((details->>'size')::bigint, 0)), 0) INTO used_user
    FROM store_events WHERE event = 'app_file_opened' AND occurred_at > now() - interval '1 hour' AND details->>'userId' = p_user::text;
  SELECT COALESCE(SUM(GREATEST((details->>'size')::bigint, 0)), 0) INTO used_device
    FROM store_events WHERE event = 'app_file_opened' AND occurred_at > now() - interval '1 hour' AND details->>'deviceId' = p_device::text;
  IF used_device + cost > p_device_limit OR used_user + cost > p_user_limit THEN
    IF NOT EXISTS (SELECT 1 FROM store_events WHERE event = 'app_download_limit_hit' AND occurred_at > now() - interval '10 minutes' AND details->>'deviceId' = p_device::text) THEN
      INSERT INTO store_events (event, actor, owner_id, file_id, name_snapshot, details)
      VALUES ('app_download_limit_hit', p_user, p_owner, p_file, p_name,
              jsonb_build_object('deviceId', p_device, 'userId', p_user, 'usedDevice', used_device, 'usedUser', used_user, 'wanted', cost));
    END IF;
    RETURN jsonb_build_object('allowed', false, 'usedDevice', used_device, 'usedUser', used_user);
  END IF;
  INSERT INTO store_events (event, actor, owner_id, file_id, name_snapshot, details)
  VALUES ('app_file_opened', p_user, p_owner, p_file, p_name, jsonb_build_object('deviceId', p_device, 'userId', p_user, 'size', cost));
  RETURN jsonb_build_object('allowed', true, 'usedDevice', used_device + cost, 'usedUser', used_user + cost);
END $$;
REVOKE ALL ON FUNCTION public.storage_app_reserve_read(uuid, uuid, uuid, uuid, text, bigint, bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storage_app_reserve_read(uuid, uuid, uuid, uuid, text, bigint, bigint, bigint) TO service_role;

-- the audit table is only ever INSERTed (append-only); the limit query reads it by event + time
CREATE INDEX IF NOT EXISTS store_events_event_at_idx ON public.store_events (event, occurred_at);
