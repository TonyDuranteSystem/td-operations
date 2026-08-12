-- ============================================================================
-- OFFER PAYMENT PLANS — a setup fee paid in parts. WS-C item 2, dev job c0a61e44.
--
-- WHY: a client agrees to pay a setup fee in two goes (Domenico: EUR1,250 on
-- signing, EUR1,250 when his bank account opens) and the system has nowhere to
-- record it. His EUR2,500 commitment existed only in the signed contract and in
-- prose, so signing minted ONE EUR2,500 invoice, his EUR1,250 looked like half a
-- bill rather than a paid first part, and nothing knew a second part was coming.
--
-- ── ONE INVOICE PER PART (Antonio's decision, 2026-08-09) ────────────────────
-- He first argued one contract = one invoice with partial payments. The decider
-- was his OWN annual management, which already bills a separate invoice per
-- instalment. So: each part is its own invoice, created at its own value. The
-- normal path NEVER mints the full sum and reduces it — that was the retrofit
-- move available on his already-signed offer, not the model's behaviour.
--
-- ⛔ VOCABULARY, CLIENT-FACING, NON-NEGOTIABLE. "Instalment" belongs to the
-- RENEWAL contract and must never appear in client-facing text for a split setup
-- fee. Antonio's own wording on Domenico's invoice is "Partial Payment". The
-- separation from the annual Jan/Jun machinery has to hold in the WORDS as well
-- as in the data — which is why the new category below is `setup_tranche` and NOT
-- one of the installment values.
--
-- ⛔ WHY REUSING installment_1/installment_2 WOULD BE A REAL BUG, not a naming
-- preference: paying an invoice categorised that way fires the paid-installment
-- handler, which lifts a client's ACCOUNTANT HAND-OFF GATE and advances their tax
-- card, and it feeds the June cron and the instalment badge. A formation client
-- paying part two of a setup fee must trigger none of that.
-- ============================================================================

-- ── 1. THE PLAN, ON THE OFFER ───────────────────────────────────────────────
-- A LIST of parts, not two slots: adding a third part must never need a migration.
-- Shape (validated in code by lib/offers/payment-plan.ts, which is the authority):
--   [{ "seq": 1, "amount": 1250, "currency": "EUR",
--      "trigger": { "kind": "signing" },
--      "internal_label": "on signing" },
--    { "seq": 2, "amount": 1250, "currency": "EUR",
--      "trigger": { "kind": "event", "event": "bank_account_opened" },
--      "internal_label": "when the bank account opens" }]
--
-- `trigger.kind` is one of signing | event | date | manual. "manual" is ALWAYS
-- available, and there is deliberately NO DATE ENGINE: a date-triggered part
-- surfaces as something a human is reminded of, and minting stays a click.
-- Nothing bills a client unattended.
--
-- NULL = today's behaviour exactly (one invoice for the whole setup fee), so every
-- existing offer is unaffected.
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS payment_plan jsonb;

COMMENT ON COLUMN public.offers.payment_plan IS
  'Setup fee paid in parts: ordered list of {seq, amount, currency, trigger{kind,event?,date?}, internal_label}. NULL = single payment. One currency per plan, enforced at save. Client-facing text must never say "instalment" — that word belongs to the renewal contract. Validated by lib/offers/payment-plan.ts. WS-C item 2, dev job c0a61e44.';

-- ── 2. LINEAGE: WHICH PART OF WHICH PLAN AN INVOICE IS ──────────────────────
-- Without this a later part is an orphan: the offer-cancel cascade finds invoices
-- through a SINGLE pointer on the activation row, so cancelling a plan-bearing
-- offer would leave part two alive and billable against a dead deal. The schedule
-- shown to the client needs the same tie to say which part was paid when.
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS tranche_offer_token text;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS tranche_seq integer;

COMMENT ON COLUMN public.payments.tranche_offer_token IS
  'The offer whose payment plan this invoice is one part of. NULL for every ordinary invoice. Read by the offer-cancel cascade and the client-facing schedule.';
COMMENT ON COLUMN public.payments.tranche_seq IS
  'Which part of that plan (1-based, matches payment_plan[].seq).';

-- Both or neither — a part number without an offer identifies nothing.
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_tranche_pair_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_tranche_pair_check CHECK (
  (tranche_offer_token IS NULL AND tranche_seq IS NULL)
  OR (tranche_offer_token IS NOT NULL AND tranche_seq IS NOT NULL AND tranche_seq >= 1)
);

-- ONE LIVE INVOICE PER PART. This is the model's core promise: clicking "issue the
-- next part" twice must not bill a client twice.
--
-- Cancelled invoices are excluded from the index on purpose, so a part whose
-- invoice was voided can be re-minted. (Same partial-index caveat as elsewhere: a
-- PARTIAL unique index cannot back an upsert's ON CONFLICT — Postgres raises
-- 42P10 — so writers must read-then-insert, never upsert onto this.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_one_invoice_per_tranche
  ON public.payments (tranche_offer_token, tranche_seq)
  WHERE tranche_offer_token IS NOT NULL AND invoice_status <> 'Cancelled';

-- The cascade's lookup: every invoice belonging to one offer's plan.
CREATE INDEX IF NOT EXISTS idx_payments_tranche_offer_token
  ON public.payments (tranche_offer_token) WHERE tranche_offer_token IS NOT NULL;

-- ── 3. THE CATEGORY ─────────────────────────────────────────────────────────
-- Added to the CHECK here; added to PAYMENT_CATEGORIES in
-- lib/billing/payment-classification.ts in the same change; and the column is
-- already registered in the code-to-database contract check, so the two lists
-- cannot drift silently the way `td_communication` once did.
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_payment_category_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_payment_category_check CHECK (
  payment_category IS NULL OR payment_category = ANY (ARRAY[
    'setup_fee'::text,
    -- Offer payment plans. Deliberately NOT installment_1/installment_2 — see the
    -- header: those fire the tax hand-off gate and the June cron.
    'setup_tranche'::text,
    'installment_1'::text,
    'installment_2'::text,
    'annual_renewal'::text,
    'one_time'::text,
    'itin'::text,
    'custom'::text,
    'credit'::text,
    'other'::text,
    'td_communication'::text
  ])
);
