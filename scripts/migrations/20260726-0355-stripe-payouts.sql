-- Stripe payouts feed — the source-of-truth list of TD's real Stripe payouts,
-- so a bank deposit labelled a Stripe transfer can be confirmed against an ACTUAL
-- payout by amount + arrival date (wording-free, bank-agnostic).
--
-- Why this table exists: Plaid/Relay give a bank credit no Stripe payout id and an
-- unreliable category. Stripe itself knows every payout's exact amount + arrival date;
-- matching a "STRIPE - TRANSFER" deposit to one of these rows is the structured proof
-- that upgrades a name-signature guess to a certain classification.
--
-- amount is stored SIGNED in dollars exactly as Stripe reports (a rare negative payout =
-- money pulled back from the bank); matching is done on the absolute value + a tight
-- arrival-date window. livemode is kept so a test-mode payout can never confirm a real
-- deposit.

CREATE TABLE IF NOT EXISTS stripe_payouts (
  id            text PRIMARY KEY,                 -- Stripe payout id, e.g. po_1TwX7b...
  amount        numeric NOT NULL,                 -- signed dollars (amount/100 from Stripe)
  currency      text    NOT NULL DEFAULT 'usd',
  arrival_date  date    NOT NULL,                 -- bank landing date (from arrival_date unix)
  status        text    NOT NULL,                 -- paid / pending / in_transit / canceled / failed
  livemode      boolean NOT NULL DEFAULT true,
  raw_data      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The match lookup: given a bank deposit's absolute amount + date, find the payout.
CREATE INDEX IF NOT EXISTS idx_stripe_payouts_amount_arrival
  ON stripe_payouts (amount, arrival_date);

CREATE INDEX IF NOT EXISTS idx_stripe_payouts_arrival
  ON stripe_payouts (arrival_date);
