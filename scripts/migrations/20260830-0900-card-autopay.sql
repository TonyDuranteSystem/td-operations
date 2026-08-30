-- Client card-autopay (dev job 10995181) — Phase 1: card only, for the January/June
-- annual renewal installments. ACH is a deliberately separate, later phase.
--
-- accounts.autopay_* — the saved card, set once at enrollment (a Stripe Checkout
-- Session in "setup" mode, on-session — see app/api/webhooks/stripe/route.ts's
-- new setup-mode branch). autopay_card_enabled is the ONE field any charging
-- code may trust; the others are display/reference only.
--
-- payments.charge_claimed_until + stripe_checkout_session_id — the fix for the
-- double-charge race between a client's own "Pay Invoice" click and the
-- unattended auto-charge cron, both able to act on the same invoice. Both
-- paths must atomically win charge_claimed_until (a conditional UPDATE that
-- also re-checks status != 'Paid' in the SAME statement — see
-- lib/offers/autopay-claim.ts) before creating ANY Stripe object. The cron
-- additionally uses stripe_checkout_session_id to actively expire a client's
-- already-open payment page before charging, since Stripe won't let a
-- Checkout Session expire in under 30 minutes on its own.

ALTER TABLE accounts
  ADD COLUMN autopay_card_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN autopay_stripe_customer_id text,
  ADD COLUMN autopay_stripe_payment_method_id text,
  ADD COLUMN autopay_card_last4 text;

COMMENT ON COLUMN accounts.autopay_card_enabled IS
  'The only field charging code may trust to decide whether to auto-charge this account''s card. Set true only after a real SetupIntent/Checkout(mode=setup) succeeds.';

ALTER TABLE payments
  ADD COLUMN charge_claimed_until timestamptz,
  ADD COLUMN stripe_checkout_session_id text;

COMMENT ON COLUMN payments.charge_claimed_until IS
  'Atomic claim: whichever caller (client Pay-Invoice click or the auto-charge cron) wins this via a conditional UPDATE (... WHERE charge_claimed_until IS NULL OR charge_claimed_until < now()) AND status != ''Paid'' RETURNING id may proceed to call Stripe. The other must not.';
COMMENT ON COLUMN payments.stripe_checkout_session_id IS
  'The most recent Checkout Session created for this invoice via the portal Pay button, so the auto-charge cron can actively expire it before charging (Stripe will not let a session expire in under 30 minutes on its own).';

CREATE INDEX IF NOT EXISTS idx_payments_charge_claimed_until ON payments (charge_claimed_until) WHERE charge_claimed_until IS NOT NULL;
