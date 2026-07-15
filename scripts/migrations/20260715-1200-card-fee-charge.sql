-- Card processing fee — CHARGE it (was displayed everywhere, collected nowhere on
-- Stripe since Stripe replaced Whop). dev_task 6ec6872a. Plan v4, approved by both
-- supervisors. Gateway-neutral, configurable, pinned-per-deal.
--
-- Sequence (R105): add columns → backfill → add partial unique index. No RPC.
-- Prod DDL is Antonio-run in the Supabase dashboard; this file is applied to sandbox
-- first via node scripts/apply-migration.js (or statement-by-statement).
--
-- NOTHING here re-prices anything: every existing offer/invoice is backfilled to the
-- current 5%, and the fee is only ever CHARGED by new code on a card payment.

-- ── 1. Pinned rate on the offer (drives contract wording) ──────────────────────
ALTER TABLE offers      ADD COLUMN IF NOT EXISTS card_fee_rate numeric(5,4);
COMMENT ON COLUMN offers.card_fee_rate IS
  'Card fee fraction (0.0500 = 5%) PINNED at offer creation. Drives contract wording. Never re-read from live config. dev_task 6ec6872a.';

-- ── 2. Pinned rate + the money-truth column on the invoice (payments) ──────────
ALTER TABLE payments    ADD COLUMN IF NOT EXISTS card_fee_rate  numeric(5,4);
ALTER TABLE payments    ADD COLUMN IF NOT EXISTS card_fee_amount numeric;
COMMENT ON COLUMN payments.card_fee_rate IS
  'Card fee fraction pinned at invoice creation (inherits the source offer''s pin, else app_settings). AUTHORITATIVE at charge. dev_task 6ec6872a.';
COMMENT ON COLUMN payments.card_fee_amount IS
  'The card processing fee actually charged, in major units. The MONEY-TRUTH. Invariant: card_fee_amount = sum(payment_items.amount WHERE item_type=''fee'') = total - base. 0 when paid by wire. dev_task 6ec6872a.';

-- Guard: a fee rate outside 0–100% is always a typo, never intent.
ALTER TABLE offers  DROP CONSTRAINT IF EXISTS offers_card_fee_rate_range;
ALTER TABLE offers  ADD  CONSTRAINT offers_card_fee_rate_range
  CHECK (card_fee_rate IS NULL OR (card_fee_rate >= 0 AND card_fee_rate <= 1));
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_card_fee_rate_range;
ALTER TABLE payments ADD  CONSTRAINT payments_card_fee_rate_range
  CHECK (card_fee_rate IS NULL OR (card_fee_rate >= 0 AND card_fee_rate <= 1));

-- ── 3. Structural fee-line marker on line items ────────────────────────────────
-- 'service' = a normal billable line (the immutable base). 'fee' = the card fee line.
ALTER TABLE payment_items ADD COLUMN IF NOT EXISTS item_type text NOT NULL DEFAULT 'service';
ALTER TABLE payment_items DROP CONSTRAINT IF EXISTS payment_items_item_type_check;
ALTER TABLE payment_items ADD  CONSTRAINT payment_items_item_type_check
  CHECK (item_type IN ('service','fee'));
COMMENT ON COLUMN payment_items.item_type IS
  'service = base billable line; fee = the card processing fee line. base = sum WHERE item_type<>''fee''. dev_task 6ec6872a.';

-- ── 4. Backfill so nothing re-prices on the first rate edit ────────────────────
UPDATE offers   SET card_fee_rate = 0.05 WHERE card_fee_rate IS NULL;
-- Open (non-terminal) invoices inherit 5%; terminal ones too (harmless, keeps them consistent).
UPDATE payments SET card_fee_rate = 0.05 WHERE card_fee_rate IS NULL;
-- Existing line items are all 'service' (default already set them; explicit for clarity).
UPDATE payment_items SET item_type = 'service' WHERE item_type IS NULL;

-- ── 5. One fee line per invoice (retry-safe fee booking) ───────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_items_one_fee_per_payment
  ON payment_items (payment_id) WHERE item_type = 'fee';

-- ── 6. Configurable rate lives in app_settings (not the catalog) ───────────────
-- Read ONLY at offer creation / offer-less invoice creation; never at charge; never
-- for display of a pinned entity. Editable from the CRM settings surface.
-- `enabled` is the GLOBAL KILL SWITCH the charge path checks (overrides every per-deal
-- pin when false → charges base, no redeploy). Defaults ON. See docs/runbooks/card-fee-go-live.md.
INSERT INTO app_settings (key, value)
VALUES ('payment_fee_config', jsonb_build_object('card_rate', 0.05, 'enabled', true))
ON CONFLICT (key) DO NOTHING;
