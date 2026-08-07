-- WS-A (dev job c0a61e44): what KIND of credit the offer is showing.
--
-- The display snapshot is the SUM of every unspent credit the person holds, but
-- the client-facing line read "Already paid — Strategy Call". A client who had
-- referred someone and held a referral credit was told that credit was a paid
-- call. The money was right; the sentence was false, and it is the sentence a
-- client quotes back.
--
-- 'paid_call' only when every contributing credit is a paid strategy call.
-- Anything else renders the neutral "Credit applied" / "Credito applicato".
-- NULL on older rows ⇒ the neutral wording, which is never wrong.

ALTER TABLE offers ADD COLUMN IF NOT EXISTS credit_kind text;

COMMENT ON COLUMN offers.credit_kind IS
  'WS-A display-only: ''paid_call'' when every credit in credit_amount is a paid strategy call, else NULL/other. Drives the client-facing label only; never used to compute money.';
