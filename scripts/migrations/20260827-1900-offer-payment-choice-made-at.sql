-- Client-chosen split payment, corrected design (council review, 2026-08-27,
-- second pass — the first shipped version fabricated paid revenue because the
-- choice happened AFTER signing, when a full-price invoice already existed;
-- see docs/systems/offers.md for the full finding). The fix moves the choice
-- to BEFORE signing, the same way a multi-option offer's package pick already
-- has to happen before signing — see package_locked_at, which this column
-- deliberately mirrors.
--
-- NULL = the client (on an offer with allow_split_payment_choice=true) has
-- not yet decided how to pay. Non-null = locked, whichever way they chose
-- ("split" also sets payment_plan in the SAME write; "full" sets only this
-- column). Always treated as ONE atomic unit together with payment_plan by
-- anything that copies an offer (see lib/offers/revise-copy.ts) or resets a
-- package pick (lib/offers/package-pick.ts) — a bug-hunter finding on the
-- plan: dropping one without the other leaves a client-facing dead end.

ALTER TABLE offers ADD COLUMN IF NOT EXISTS payment_choice_made_at timestamptz;

COMMENT ON COLUMN offers.payment_choice_made_at IS
  'When the client locked in how they will pay (full vs split), on an offer with allow_split_payment_choice=true. NULL = not yet decided (or the offer does not offer this choice). The pick-lock write is a compare-and-swap on this column being NULL, mirroring offers.package_locked_at — see app/api/offers/choose-payment-split/route.ts. Always copied/cleared together with payment_plan, never independently.';
