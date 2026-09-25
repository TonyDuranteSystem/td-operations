-- WhatsApp bridge (dev job 907b2535, child e23343a6): Reconnect from the CRM.
-- Antonio 2026-09-25: "reconnect button" — when WhatsApp unlinks the device he must be able to re-link it from the CRM
-- without a terminal. Council-reviewed simple design (bug hunter + AI architect + project director):
--   * the Mac, when GOWA reports logged_in=false, asks its own GOWA for a pairing code (POST /devices/td-crm/login/code)
--     and posts it (signed) to the receiver as bridge.linkcode;
--   * the CRM keeps ONLY the latest code + when it arrived + how many codes were requested in this outage;
--   * the owner-only page shows it if it is < 2 minutes old and the bridge is still unlinked; he types it in
--     WhatsApp > Linked devices > Link with phone number.
-- No new table, no request handshake: three columns on wa_bridge_state, each written by its OWN atomic function
-- (the 2026-09-24 council found a shared JSON blob caused lost updates between the heartbeat/cron/ingest writers).
--
-- Guardrails:
--   * wabridge_set_link_code refuses when the device is logged in, and after 5 codes in one outage (ban-risk cap;
--     the Mac keeps its own counter too). A healthy heartbeat (logged_in=true) clears the code and resets the counter,
--     so a stale code can never be shown after a successful pairing.
--   * service_role only (RLS on wa_bridge_state has no policies). The code never goes in config_json (readable by MCP tools).
--
-- Sandbox: statement-by-statement via exec_sql. Production: Antonio runs it in the Supabase SQL editor.

ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS link_code text;
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS link_code_at timestamptz;
ALTER TABLE public.wa_bridge_state ADD COLUMN IF NOT EXISTS link_attempts integer NOT NULL DEFAULT 0;

-- wabridge_record_heartbeat: unchanged behaviour + a logged-in beat clears the pairing code and resets the attempt counter.
CREATE OR REPLACE FUNCTION public.wabridge_record_heartbeat(
  p_channel_id uuid, p_reachable boolean, p_connected boolean, p_logged_in boolean
) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_healthy boolean := COALESCE(p_reachable, false) AND COALESCE(p_connected, false) AND COALESCE(p_logged_in, false);
BEGIN
  INSERT INTO wa_bridge_state (channel_id, last_heartbeat_at, reachable, connected, logged_in, bad_beats, updated_at)
  VALUES (p_channel_id, now(), p_reachable, p_connected, p_logged_in, CASE WHEN v_healthy THEN 0 ELSE 1 END, now())
  ON CONFLICT (channel_id) DO UPDATE SET
    last_heartbeat_at = now(),
    reachable = EXCLUDED.reachable,
    connected = EXCLUDED.connected,
    logged_in = EXCLUDED.logged_in,
    bad_beats = CASE WHEN v_healthy THEN 0 ELSE wa_bridge_state.bad_beats + 1 END,
    link_code = CASE WHEN COALESCE(p_logged_in, false) THEN NULL ELSE wa_bridge_state.link_code END,
    link_code_at = CASE WHEN COALESCE(p_logged_in, false) THEN NULL ELSE wa_bridge_state.link_code_at END,
    link_attempts = CASE WHEN COALESCE(p_logged_in, false) THEN 0 ELSE wa_bridge_state.link_attempts END,
    updated_at = now();
END;
$$;

-- Store the latest pairing code. Returns true if stored, false if refused (device is logged in, or the outage cap is reached).
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
      link_attempts = link_attempts + 1,
      updated_at = now()
  WHERE channel_id = p_channel_id
    AND logged_in IS NOT TRUE
    AND link_attempts < 5;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.wabridge_record_heartbeat(uuid, boolean, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_record_heartbeat(uuid, boolean, boolean, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.wabridge_set_link_code(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wabridge_set_link_code(uuid, text) TO service_role;
