-- Offer builder Part 3, item B (dev job d2971d11): stop one offer being emailed twice when two Sends run at almost the same moment.
--
-- Send now "claims" the offer before it makes the client's login or sends the email: it writes the time into this column, but
-- only if the offer is still a draft AND nobody else holds a claim younger than 10 minutes. The write is one atomic statement,
-- so of two simultaneous Sends exactly one gets a row back and the other stops without sending anything.
--   NULL                      = nobody is sending this offer
--   a time less than 10 min old = a Send is (or just was) in progress
--   a time 10+ min old        = a Send that died (server stopped); the claim no longer counts, so Send can be tried again
-- A Send that fails before the email goes out gives the claim back (sets it to NULL). A Send that finishes clears it in the same
-- write that marks the offer "sent".
--
-- Additive, nullable, no default, no backfill: every existing offer reads as "nobody is sending this".
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS send_started_at timestamptz NULL;

COMMENT ON COLUMN public.offers.send_started_at IS
  'Set by Send (lib/offers/send-claim.ts) while it sends this offer; NULL otherwise. A value younger than 10 minutes blocks a second Send of the same draft. Cleared when the offer is marked sent or the send fails before the email goes out.';
