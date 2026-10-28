-- WhatsApp bridge (dev job 69c6ce32): pairing codes ON DEMAND + "Recover missing messages".
-- Antonio 2026-10-28: after the phone logged the link out, the Mac created all 5 pairing codes by itself in 8 minutes with
-- nobody at the screen; both the CRM and the Mac stop at 5 per outage, so the link could not be re-made without a manual
-- database reset. He asked for (1) a code only when someone asks for one, and (2) a button that recovers messages the CRM missed.
--
-- Design (no new table; each column group is written by its OWN atomic function — the 2026-09-24 lost-update lesson):
--   * "Get a new code"  -> wabridge_request_link_code  stamps link_code_wanted_at
--   * the Mac's next heartbeat reply carries what is wanted (wabridge_take_commands) -> it asks GOWA for a code -> bridge.linkcode
--     -> wabridge_set_link_code stores it (and clears the "wanted" stamp)
--   * the code cap is now 5 per rolling HOUR (link_window_at), not 5 per outage forever, so nobody can be locked out for good
--   * "Recover missing messages" -> wabridge_request_recover stamps recover_requested_at; the heartbeat reply hands the job to
--     the Mac ONCE (recover_started_at); the Mac runs its normal catch-up and reports -> wabridge_set_recover_result
--
-- wabridge_record_heartbeat is NOT touched (it still clears the code and zeroes link_attempts on a healthy beat).
-- Service role only (RLS on wa_bridge_state has no policies). Sandbox: node scripts/apply-migration.js <this file>.
-- Production: Antonio runs it in the Supabase SQL editor.

ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS link_window_at timestamptz;
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS link_code_wanted_at timestamptz;
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS recover_requested_at timestamptz;
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS recover_started_at timestamptz;
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS recover_done_at timestamptz;
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS recover_saved integer;
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS recover_read integer;

-- Store the latest pairing code. Returns true if stored, false if refused (device is logged in, or 5 codes were already made
-- in the current hour). The hour window starts at the first code of a burst; a code after the window has passed starts a new one.
CREATE OR REPLACE FUNCTION public.wabridge_set_link_code(p_channel_id uuid, p_code text) RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE wa_bridge_state
  SET link_code = p_code,
      link_code_at = now(),
      link_attempts = CASE WHEN link_window_at IS NULL OR link_window_at < now() - interval '1 hour' THEN 1 ELSE link_attempts + 1 END,
      link_window_at = CASE WHEN link_window_at IS NULL OR link_window_at < now() - interval '1 hour' THEN now() ELSE link_window_at END,
      link_code_wanted_at = NULL,
      updated_at = now()
  WHERE channel_id = p_channel_id
    AND logged_in IS NOT TRUE
    AND (link_window_at IS NULL OR link_window_at < now() - interval '1 hour' OR link_attempts < 5);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- "Get a new code" pressed. {result:'ok'} = the Mac will be asked on its next beat; 'linked' = nothing to do (already logged in);
-- 'limit' = 5 codes were made in the last hour (retry_at says when the hour is over).
CREATE OR REPLACE FUNCTION public.wabridge_request_link_code(p_channel_id uuid) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  s wa_bridge_state%ROWTYPE;
BEGIN
  SELECT * INTO s FROM wa_bridge_state WHERE channel_id = p_channel_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unknown'); END IF;
  IF s.logged_in IS TRUE THEN RETURN jsonb_build_object('result', 'linked'); END IF;
  IF s.link_window_at IS NOT NULL AND s.link_window_at >= now() - interval '1 hour' AND s.link_attempts >= 5 THEN
    RETURN jsonb_build_object('result', 'limit', 'retry_at', s.link_window_at + interval '1 hour');
  END IF;
  UPDATE wa_bridge_state SET link_code_wanted_at = now(), updated_at = now() WHERE channel_id = p_channel_id;
  RETURN jsonb_build_object('result', 'ok');
END;
$$;

-- "Recover missing messages" pressed. {result:'already'} when a request is still in flight (so a double click does nothing twice).
CREATE OR REPLACE FUNCTION public.wabridge_request_recover(p_channel_id uuid) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  s wa_bridge_state%ROWTYPE;
BEGIN
  SELECT * INTO s FROM wa_bridge_state WHERE channel_id = p_channel_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'unknown'); END IF;
  IF s.recover_requested_at IS NOT NULL AND s.recover_requested_at > now() - interval '5 minutes' AND s.recover_done_at IS NULL THEN
    RETURN jsonb_build_object('result', 'already');
  END IF;
  UPDATE wa_bridge_state
  SET recover_requested_at = now(), recover_started_at = NULL, recover_done_at = NULL, recover_saved = NULL, recover_read = NULL, updated_at = now()
  WHERE channel_id = p_channel_id;
  RETURN jsonb_build_object('result', 'ok');
END;
$$;

-- What the Mac should do next, answered on its heartbeat. A recover job is handed out ONCE (re-offered only if it was handed out
-- more than 3 minutes ago and never reported back); a code request is offered while it is under 5 minutes old and the device is unlinked.
CREATE OR REPLACE FUNCTION public.wabridge_take_commands(p_channel_id uuid) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  s wa_bridge_state%ROWTYPE;
  v_want boolean;
  v_recover boolean;
BEGIN
  SELECT * INTO s FROM wa_bridge_state WHERE channel_id = p_channel_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('want_code', false, 'recover_days', NULL); END IF;
  v_want := s.logged_in IS NOT TRUE AND s.link_code_wanted_at IS NOT NULL AND s.link_code_wanted_at > now() - interval '5 minutes';
  v_recover := s.recover_requested_at IS NOT NULL
    AND s.recover_requested_at > now() - interval '5 minutes'
    AND s.recover_done_at IS NULL
    AND (s.recover_started_at IS NULL OR s.recover_started_at < now() - interval '3 minutes');
  IF v_recover THEN
    UPDATE wa_bridge_state SET recover_started_at = now() WHERE channel_id = p_channel_id;
  END IF;
  RETURN jsonb_build_object('want_code', v_want, 'recover_days', CASE WHEN v_recover THEN 7 ELSE NULL END);
END;
$$;

-- The Mac's report for a recover job: how many messages its catch-up read and how many were new to the CRM.
CREATE OR REPLACE FUNCTION public.wabridge_set_recover_result(p_channel_id uuid, p_saved integer, p_read integer) RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE wa_bridge_state
  SET recover_done_at = now(), recover_saved = GREATEST(p_saved, 0), recover_read = GREATEST(p_read, 0), updated_at = now()
  WHERE channel_id = p_channel_id AND recover_requested_at IS NOT NULL AND recover_done_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.wabridge_set_link_code(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_set_link_code(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_request_link_code(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_request_link_code(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_request_recover(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_request_recover(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_take_commands(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_take_commands(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_set_recover_result(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_set_recover_result(uuid, integer, integer) TO service_role;
