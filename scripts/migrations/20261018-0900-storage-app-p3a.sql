-- Storage Mac app, phase P3 step A (dev job 1992a087): the UPLOAD limit, atomic. SANDBOX first (R105). UNDO: 20261018-0900-storage-app-p3a.UNDO.sql
--
-- storage_app_reserve_write(...) is the ONLY way a Mac gets an upload slot: in ONE transaction, under a lock per Mac, it adds up what this
-- Mac reserved to upload in the last hour (minus what was given back after a failed save), refuses when the new file does not fit, and
-- otherwise writes the audit row `app_upload_reserved`. The same file (same caller_key) asking again within 3 hours is NOT counted twice (a
-- retry after a lost answer). A refusal writes ONE `app_upload_limit_hit` row per Mac per 10 minutes. A file of unknown size counts as 1 MB.
CREATE OR REPLACE FUNCTION public.storage_app_reserve_write(
  p_device uuid, p_user uuid, p_owner uuid, p_name text, p_caller_key text, p_size bigint, p_limit bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  cost bigint := GREATEST(COALESCE(p_size, 0), 1048576);
  reserved bigint; refunded bigint; used bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('storage_app_write:' || p_device::text, 0));
  -- the same file again (a retry): already counted, unless it was given back
  IF EXISTS (SELECT 1 FROM store_events r WHERE r.event = 'app_upload_reserved' AND r.occurred_at > now() - interval '3 hours'
               AND r.details->>'callerKey' = p_caller_key
               AND NOT EXISTS (SELECT 1 FROM store_events g WHERE g.event = 'app_upload_refunded' AND g.occurred_at >= r.occurred_at AND g.details->>'callerKey' = p_caller_key)) THEN
    RETURN jsonb_build_object('allowed', true, 'repeat', true);
  END IF;
  SELECT COALESCE(SUM(GREATEST((details->>'size')::bigint, 0)), 0) INTO reserved
    FROM store_events WHERE event = 'app_upload_reserved' AND occurred_at > now() - interval '1 hour' AND details->>'deviceId' = p_device::text;
  SELECT COALESCE(SUM(GREATEST((details->>'size')::bigint, 0)), 0) INTO refunded
    FROM store_events WHERE event = 'app_upload_refunded' AND occurred_at > now() - interval '1 hour' AND details->>'deviceId' = p_device::text;
  used := GREATEST(reserved - refunded, 0);
  IF used + cost > p_limit THEN
    IF NOT EXISTS (SELECT 1 FROM store_events WHERE event = 'app_upload_limit_hit' AND occurred_at > now() - interval '10 minutes' AND details->>'deviceId' = p_device::text) THEN
      INSERT INTO store_events (event, actor, owner_id, name_snapshot, details)
      VALUES ('app_upload_limit_hit', p_user, p_owner, p_name, jsonb_build_object('deviceId', p_device, 'userId', p_user, 'used', used, 'wanted', cost));
    END IF;
    RETURN jsonb_build_object('allowed', false, 'used', used);
  END IF;
  INSERT INTO store_events (event, actor, owner_id, name_snapshot, details)
  VALUES ('app_upload_reserved', p_user, p_owner, p_name, jsonb_build_object('deviceId', p_device, 'userId', p_user, 'size', cost, 'callerKey', p_caller_key));
  RETURN jsonb_build_object('allowed', true, 'used', used + cost);
END $$;
REVOKE ALL ON FUNCTION public.storage_app_reserve_write(uuid, uuid, uuid, text, text, bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storage_app_reserve_write(uuid, uuid, uuid, text, text, bigint, bigint) TO service_role;
