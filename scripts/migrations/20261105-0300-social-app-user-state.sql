-- TD Social (iPhone app), Step 2 / pull request B (dev job 2072bc3e): each person's alert switches and "last opened" times.
-- SANDBOX first (R105). UNDO: 20261105-0300-social-app-user-state.UNDO.sql
--
-- One row per person. Three small columns, written by TWO small functions so that two phones (or the phone and the web) can never undo
-- each other's change (Council review, 5 Nov 2026):
--   * social_app_merge_prefs   — merges the switches KEY BY KEY (muted tabs, alert switches). Only overrides are stored; a missing key means
--                                "use the rule's default" (lib/app/prefs.ts), so a new tab or mailbox needs no data change.
--   * social_app_mark_inbox_opened — records when the person last opened a mailbox. It only ever moves FORWARD (greatest of old and new), or,
--                                with p_only_if_missing, sets the very first baseline and never moves an existing one.
-- Both are called only by the server with the service key (EXECUTE revoked from everyone else), and the table is closed to browser tokens.
--
-- DESIGN RULES: NO CHECK value lists (validated in code, lib/app/prefs.ts); nothing reads this table until `social_app_enabled` is true.

CREATE TABLE IF NOT EXISTS public.social_app_user_state (
  user_id      uuid PRIMARY KEY,
  muted_tabs   text[]      NOT NULL DEFAULT '{}',
  alerts       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  inbox_opened jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.social_app_user_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.social_app_user_state FROM anon, authenticated;

-- p_mute: {"talk": true, "portal": false}  true = mute, false = unmute; keys not named are left alone.
-- p_alerts: {"whatsapp": false, "email:support": true}  shallow-merged over what is stored.
CREATE OR REPLACE FUNCTION public.social_app_merge_prefs(p_user uuid, p_mute jsonb, p_alerts jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  add_t text[];
  rem_t text[];
BEGIN
  SELECT coalesce(array_agg(e.k), '{}') INTO add_t FROM jsonb_each_text(coalesce(p_mute, '{}'::jsonb)) AS e(k, v) WHERE e.v = 'true';
  SELECT coalesce(array_agg(e.k), '{}') INTO rem_t FROM jsonb_each_text(coalesce(p_mute, '{}'::jsonb)) AS e(k, v) WHERE e.v = 'false';
  INSERT INTO public.social_app_user_state AS s (user_id, muted_tabs, alerts)
  VALUES (p_user, add_t, coalesce(p_alerts, '{}'::jsonb))
  ON CONFLICT (user_id) DO UPDATE SET
    muted_tabs = ARRAY(SELECT DISTINCT t FROM unnest(s.muted_tabs || add_t) AS t WHERE t <> ALL (rem_t) ORDER BY t),
    alerts     = s.alerts || coalesce(p_alerts, '{}'::jsonb),
    updated_at = now();
END $$;

-- Returns the stored time for that mailbox after the call.
CREATE OR REPLACE FUNCTION public.social_app_mark_inbox_opened(p_user uuid, p_mailbox text, p_at timestamptz, p_only_if_missing boolean DEFAULT false)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  result timestamptz;
BEGIN
  INSERT INTO public.social_app_user_state AS s (user_id, inbox_opened)
  VALUES (p_user, jsonb_build_object(p_mailbox, to_jsonb(p_at)))
  ON CONFLICT (user_id) DO UPDATE SET
    inbox_opened = CASE
      WHEN p_only_if_missing AND s.inbox_opened ? p_mailbox THEN s.inbox_opened
      ELSE jsonb_set(
             s.inbox_opened, ARRAY[p_mailbox],
             to_jsonb(GREATEST(coalesce((s.inbox_opened ->> p_mailbox)::timestamptz, p_at), p_at)), true)
    END,
    updated_at = now()
  RETURNING (s.inbox_opened ->> p_mailbox)::timestamptz INTO result;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.social_app_merge_prefs(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.social_app_mark_inbox_opened(uuid, text, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.social_app_merge_prefs(uuid, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.social_app_mark_inbox_opened(uuid, text, timestamptz, boolean) TO service_role;

-- The standing rule for EVERY new table (tests/unit/migrations-marketing-lock.test.ts): run the marketing database lock again.
SELECT public.marketing_lock_all_tables();
