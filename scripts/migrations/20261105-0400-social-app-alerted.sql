-- TD Social (iPhone app), Step 2 / pull request D (dev job 2072bc3e): the memory behind the WhatsApp and email phone alerts.
-- SANDBOX first (R105). UNDO: 20261105-0400-social-app-alerted.UNDO.sql
--
-- Why this exists (Council review, 5 Nov 2026): the stored copy of the mailbox re-saves whole threads from four places (the Gmail webhook, the 10-minute job,
-- the backfill and the re-index after a send), so a saved row cannot tell a NEW message from an old one. Without a memory, a replay or a backfill would buzz phones for
-- mail that was read last week. So a message may alert at most ONCE: the first caller to "claim" it wins, every later caller gets "duplicate".
-- The same table keeps the flood caps: past a cap the message is still claimed (so it can never alert later) but is silent.
--
--   social_app_claim_alert(source, message_id, per_source_cap, global_cap, window)  ->  'duplicate' | 'send' | 'silent'
--     source      = 'email:support' / 'email:antonio' / 'whatsapp:<chat id>'  (a cap applies per source and across all sources)
--     message_id  = Gmail message id / WhatsApp external message id (the caller refuses a missing id; this function refuses an empty one too)
--
-- Called only by the server with the service key (EXECUTE revoked from everyone else); the table is closed to browser tokens.
-- Old rows are cleaned up here, occasionally, so nothing else has to remember.
-- DESIGN RULES: NO CHECK value lists (validated in code); nothing calls this until `social_app_enabled` is true and the Apple key is set.

CREATE TABLE IF NOT EXISTS public.social_app_alerted (
  source     text        NOT NULL,
  message_id text        NOT NULL,
  alerted    boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, message_id)
);

CREATE INDEX IF NOT EXISTS social_app_alerted_recent_idx ON public.social_app_alerted (created_at DESC) WHERE alerted;

ALTER TABLE public.social_app_alerted ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.social_app_alerted FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.social_app_claim_alert(
  p_source text, p_message_id text, p_source_cap integer DEFAULT 5, p_global_cap integer DEFAULT 20, p_window interval DEFAULT interval '10 minutes')
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  claimed integer;
  per_source integer;
  everywhere integer;
BEGIN
  IF coalesce(btrim(p_source), '') = '' OR coalesce(btrim(p_message_id), '') = '' THEN
    RETURN 'duplicate';          -- an empty id can never be claimed, so it can never alert
  END IF;

  -- occasional tidy-up (about 2 calls in 100), never on the hot path of a flood
  IF random() < 0.02 THEN
    DELETE FROM public.social_app_alerted WHERE created_at < now() - interval '14 days';
  END IF;

  INSERT INTO public.social_app_alerted (source, message_id) VALUES (p_source, p_message_id) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS claimed = ROW_COUNT;
  IF claimed = 0 THEN
    RETURN 'duplicate';
  END IF;

  SELECT count(*) INTO per_source FROM public.social_app_alerted WHERE alerted AND source = p_source AND created_at > now() - p_window;
  SELECT count(*) INTO everywhere FROM public.social_app_alerted WHERE alerted AND created_at > now() - p_window;
  IF per_source >= p_source_cap OR everywhere >= p_global_cap THEN
    RETURN 'silent';             -- claimed (never alerts later) but over the flood cap: no buzz, the icon number still rises
  END IF;

  UPDATE public.social_app_alerted SET alerted = true WHERE source = p_source AND message_id = p_message_id;
  RETURN 'send';
END $$;

REVOKE ALL ON FUNCTION public.social_app_claim_alert(text, text, integer, integer, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.social_app_claim_alert(text, text, integer, integer, interval) TO service_role;

SELECT public.marketing_lock_all_tables();
