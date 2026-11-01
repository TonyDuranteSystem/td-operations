-- Lead window, phase B + D (dev job 6fc63c52, Antonio 2026-11-01 "finish the building"):
--   * lead_calls         one row per call of a lead (booked on, scheduled for, happened on, state) — a rebooking no
--                        longer overwrites the first booking. leads.call_date stays as the "latest booking" it always was.
--   * lead_status_moves  every automatic or staff-confirmed status move made from a call, with an undo window; an UNDONE
--                        move is the sticky marker that stops the same lead being moved automatically again.
--   * leads.owner / leads.follow_up_date   who owns the lead and when to follow up.
-- BACKFILL (idempotent, safe to re-run): bookings from stored Calendly "invitee.created" events (webhook_events), recordings
-- from call_summaries, and the lead's own call_date where nothing else covers it.
--
-- No CHECK lists on purpose (state/source values live in code: lib/leads/lead-calls.ts) — a CHECK on the shared sandbox turns
-- other sessions' CI red. The new tables are locked from a marketing login and from anon/authenticated (service client only).
-- UNDO: scripts/migrations/20261101-1600-lead-calls-moves-owner-followup.UNDO.sql

CREATE TABLE IF NOT EXISTS public.lead_calls (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  booked_at          timestamptz,
  scheduled_start    timestamptz,
  scheduled_date     date,
  state              text NOT NULL DEFAULT 'scheduled',
  happened_at        timestamptz,
  call_summary_id    uuid REFERENCES public.call_summaries(id) ON DELETE SET NULL,
  calendly_event_uri text,
  moved_to           uuid REFERENCES public.lead_calls(id) ON DELETE SET NULL,
  source             text NOT NULL DEFAULT 'calendly',
  confirmed_by       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_calls_event_uri ON public.lead_calls (calendly_event_uri) WHERE calendly_event_uri IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_calls_summary ON public.lead_calls (call_summary_id) WHERE call_summary_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_calls_lead ON public.lead_calls (lead_id, scheduled_start);
ALTER TABLE public.lead_calls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lead_calls FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.lead_status_moves (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  reason      text NOT NULL,
  source      text,
  call_id     uuid REFERENCES public.lead_calls(id) ON DELETE SET NULL,
  undo_until  timestamptz,
  undone_at   timestamptz,
  undone_by   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_status_moves_lead ON public.lead_status_moves (lead_id, created_at DESC);
ALTER TABLE public.lead_status_moves ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lead_status_moves FROM anon, authenticated;

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS owner text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS follow_up_date date;

SELECT public.marketing_lock_all_tables();

-- ── BACKFILL 1: Calendly bookings (invitee.created events stored by the webhook) ─────────────────────────
-- The auto-created events keep the Calendly payload as is; staged ones keep it under "raw". Booked on = when we received it.
INSERT INTO public.lead_calls (lead_id, booked_at, scheduled_start, scheduled_date, state, source, calendly_event_uri)
SELECT l.id,
       we.created_at,
       (p->'payload'->'scheduled_event'->>'start_time')::timestamptz,
       ((p->'payload'->'scheduled_event'->>'start_time')::timestamptz AT TIME ZONE 'America/New_York')::date,
       'scheduled',
       'backfill_calendly',
       p->'payload'->>'event'
  FROM public.webhook_events we
 CROSS JOIN LATERAL (SELECT COALESCE(we.payload->'raw', we.payload) AS p) x
  JOIN LATERAL (
        SELECT id FROM public.leads
         WHERE lower(email) = lower(COALESCE(p->'payload'->>'email', p->'payload'->'invitee'->>'email'))
         ORDER BY created_at LIMIT 1
       ) l ON true
 WHERE we.source = 'calendly'
   AND we.event_type = 'invitee.created'
   AND p->'payload'->'scheduled_event'->>'start_time' ~ '^\d{4}-\d{2}-\d{2}T'   -- a malformed time must not abort the migration
   AND p->'payload'->>'event' IS NOT NULL
ON CONFLICT (calendly_event_uri) WHERE calendly_event_uri IS NOT NULL DO NOTHING;

-- A reschedule arrives as a NEW booking that names the old invitee: the old call becomes "moved".
UPDATE public.lead_calls old
   SET state = 'moved', moved_to = nw.id, updated_at = now()
  FROM public.webhook_events we
 CROSS JOIN LATERAL (SELECT COALESCE(we.payload->'raw', we.payload) AS p) x
  JOIN public.lead_calls nw ON nw.calendly_event_uri = p->'payload'->>'event'
 WHERE we.source = 'calendly' AND we.event_type = 'invitee.created'
   AND p->'payload'->>'old_invitee' IS NOT NULL
   AND old.calendly_event_uri = split_part(p->'payload'->>'old_invitee', '/invitees/', 1)
   AND old.state = 'scheduled' AND old.id <> nw.id;

-- ── BACKFILL 2: recordings (call_summaries linked to a lead) ─────────────────────────────────────────────
DO $$
DECLARE
  cs record;
  cand uuid;
BEGIN
  FOR cs IN
    SELECT id, lead_id, created_at FROM public.call_summaries
     WHERE lead_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.lead_calls lc WHERE lc.call_summary_id = call_summaries.id)
     ORDER BY created_at
  LOOP
    SELECT lc.id INTO cand
      FROM public.lead_calls lc
     WHERE lc.lead_id = cs.lead_id AND lc.call_summary_id IS NULL AND lc.scheduled_date IS NOT NULL
       AND lc.state IN ('scheduled', 'moved')
       AND abs(lc.scheduled_date - (cs.created_at AT TIME ZONE 'America/New_York')::date) <= 1
     ORDER BY abs(lc.scheduled_date - (cs.created_at AT TIME ZONE 'America/New_York')::date), lc.scheduled_start
     LIMIT 1;
    IF cand IS NOT NULL THEN
      UPDATE public.lead_calls
         SET state = 'done', happened_at = cs.created_at, call_summary_id = cs.id, confirmed_by = 'recording', updated_at = now()
       WHERE id = cand;
    ELSE
      INSERT INTO public.lead_calls (lead_id, state, happened_at, call_summary_id, source, confirmed_by)
      VALUES (cs.lead_id, 'done', cs.created_at, cs.id, 'backfill_recording', 'recording');
    END IF;
  END LOOP;
END $$;

-- ── BACKFILL 3: a lead's own call_date that nothing above covers ─────────────────────────────────────────
INSERT INTO public.lead_calls (lead_id, scheduled_date, state, source)
SELECT l.id, l.call_date::date, 'scheduled', 'backfill_lead'
  FROM public.leads l
 WHERE l.call_date IS NOT NULL
   AND NOT EXISTS (
         SELECT 1 FROM public.lead_calls lc
          WHERE lc.lead_id = l.id AND lc.scheduled_date IS NOT NULL
            AND abs(lc.scheduled_date - l.call_date::date) <= 1);

-- verify
DO $$
DECLARE n_calls integer; n_linked integer;
BEGIN
  SELECT count(*) INTO n_calls FROM public.lead_calls;
  SELECT count(*) INTO n_linked FROM public.lead_calls WHERE call_summary_id IS NOT NULL;
  RAISE NOTICE 'lead_calls: % rows, % linked to a recording', n_calls, n_linked;
END $$;
