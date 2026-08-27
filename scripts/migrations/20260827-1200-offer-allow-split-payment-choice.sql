-- Client-chosen split payment (Antonio, 2026-08-27, following the auto-charge
-- council review — see docs/systems/offers.md's 2026-08-27 entry for the full
-- context of what was considered and rejected).
--
-- The EXISTING `payment_plan` column already holds a fully-authored, staff-
-- decided plan written at offer creation — that mechanism stays exactly as it
-- is, and is unavailable for a multi-option offer (nobody knows the price
-- until the client picks). This NEW column is a much narrower thing: a plain
-- yes/no the staffer sets on the offer ("this client may split the setup fee
-- into two payments"), decided BEFORE any price is even locked in. The actual
-- 50/50 split, and the amounts themselves, are computed and written onto
-- `payment_plan` at the moment the client chooses to use it — after signing
-- (and after picking, for a multi-option offer), when the real price is
-- finally known. See app/api/offers/choose-payment-split/route.ts.
--
-- Additive + nullable-by-default: an offer with this false (every existing
-- offer, via the default) behaves exactly as today.

ALTER TABLE offers ADD COLUMN IF NOT EXISTS allow_split_payment_choice boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN offers.allow_split_payment_choice IS
  'Staff opt-in, set at offer creation: may this client choose, at the moment they pay, to split the setup fee into two payments (50% on signing + 50% in 30 days, both carrying the pinned card fee) instead of paying in full? The split itself is computed and written onto payment_plan only when the client actually makes that choice (choose-payment-split route) — this column does not itself create a plan.';
