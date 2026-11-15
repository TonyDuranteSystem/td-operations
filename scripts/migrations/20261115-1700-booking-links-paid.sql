-- Booking page, Stage 3 (dev job 74432428): PAID links. Additive only: thirteen nullable / defaulted columns on booking_links, nothing is rewritten, nothing is backfilled.
--
-- A paid link is a normal Calendly link (a FREE call type) plus a price. The person books a time first, then pays on our own page /pay/b/<pay_code>:
--   pay_amount_cents / pay_currency   what the call costs (USD or EUR; the parser in code allows nothing else); NULL on every free link
--   pay_label                         what the invoice calls it (<= 80 characters, checked in code)
--   pay_mode                          credit | revenue_only, decided when the link is made (a new person or lead = credit toward their next new service;
--                                     an established client = revenue only), shown in the maker's preview
--   pay_code                          random 22-character id (128 bits) of the public pay address; UNIQUE
--   stripe_session_id / session_expires_at / session_claim_at
--                                     the live Stripe Checkout session of this link, reused until it expires (the pay page makes it when the payer clicks Pay);
--                                     session_claim_at is the short lease that stops two clicks at once from making two sessions
--   sent_at / sent_count              the last time staff marked the payment link as sent, and how many times
--   paid_session_id / paid_at         the Stripe session that was paid and when (first one wins; set by the Stripe webhook)
--   not_charging_at                   staff said "Not charging": the card closes and the pay page stops taking money
-- No CHECK lists (a CHECK on the shared sandbox turns other sessions' CI red); the values live in code.
-- booking_links is already locked (RLS on, no access for anon/authenticated); the new columns inherit that.
-- UNDO: 20261115-1700-booking-links-paid.UNDO.sql (refuses while any link has been paid)

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.booking_links
  ADD COLUMN IF NOT EXISTS pay_amount_cents    integer,
  ADD COLUMN IF NOT EXISTS pay_currency        text,
  ADD COLUMN IF NOT EXISTS pay_label           text,
  ADD COLUMN IF NOT EXISTS pay_mode            text,
  ADD COLUMN IF NOT EXISTS pay_code            text,
  ADD COLUMN IF NOT EXISTS stripe_session_id   text,
  ADD COLUMN IF NOT EXISTS session_expires_at  timestamptz,
  ADD COLUMN IF NOT EXISTS session_claim_at    timestamptz,
  ADD COLUMN IF NOT EXISTS sent_at             timestamptz,
  ADD COLUMN IF NOT EXISTS sent_count          integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_session_id     text,
  ADD COLUMN IF NOT EXISTS paid_at             timestamptz,
  ADD COLUMN IF NOT EXISTS not_charging_at     timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_links_pay_code ON public.booking_links (pay_code) WHERE pay_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_links_stripe_session ON public.booking_links (stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_booking_links_paid_open ON public.booking_links (created_at DESC) WHERE pay_amount_cents IS NOT NULL AND paid_session_id IS NULL AND not_charging_at IS NULL;

COMMIT;

-- verify (the Supabase SQL editor shows only this LAST result): thirteen new columns, row-level security still on, and no privileges for anon/authenticated (client_grants must be 0)
SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'booking_links'
          AND column_name IN ('pay_amount_cents','pay_currency','pay_label','pay_mode','pay_code','stripe_session_id','session_expires_at','session_claim_at','sent_at','sent_count','paid_session_id','paid_at','not_charging_at')) AS new_columns,
       c.relrowsecurity AS rls_on,
       (SELECT count(*) FROM information_schema.role_table_grants g WHERE g.table_schema = 'public' AND g.table_name = c.relname AND g.grantee IN ('anon', 'authenticated')) AS client_grants
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'booking_links';
