-- Payments to confirm (Antonio 2026-10-23, Christian Ranieri; dev job 40a58d9a).
-- WHAT: one row per Stripe payment that arrived with no label and that staff have since dealt with (what it was, who decided, when).
-- The list of payments still WAITING is not stored: it is read from the saved Stripe events minus the sessions in this table.
-- WHY the session id is the primary key: confirming twice (double click, two people) can never settle the same payment twice.
-- RLS is ON with NO policy: only the server (service role) can read or write. Safe to run again. Undo: the .UNDO.sql beside this file.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.incoming_payment_resolutions (
  stripe_session_id text PRIMARY KEY CHECK (stripe_session_id <> ''),
  resolution        text NOT NULL CHECK (resolution IN ('paid_call', 'paid_call_already_deducted', 'recorded_elsewhere')),
  contact_id        uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  lead_id           uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  invoice_payment_id uuid,
  credit_payment_id  uuid,
  note              text CHECK (note IS NULL OR char_length(note) <= 1000),
  resolved_by       text NOT NULL,
  resolved_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.incoming_payment_resolutions ENABLE ROW LEVEL SECURITY;

-- the standing rule for every new table (marketing database lock, 20261018-0110): keep new tables locked away from the marketing logins
-- (runs where that function exists — production; the sandbox copy of the lock is not installed, so it is skipped there)
DO $do$
BEGIN
  IF to_regprocedure('public.marketing_lock_all_tables()') IS NOT NULL THEN PERFORM public.marketing_lock_all_tables(); END IF;
END
$do$;

COMMIT;
