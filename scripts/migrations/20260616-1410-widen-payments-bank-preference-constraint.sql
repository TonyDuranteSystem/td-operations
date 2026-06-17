-- Widen payments.bank_preference CHECK constraint to accept id-based bank refs.
--
-- WHY: The "Invoice Settings banks" feature (commit 2aa223e3, 2026-06-12) let staff
-- pick a configured bank when creating an invoice. The Finance create path stores that
-- choice in payments.bank_preference and lib/invoice-auto-send.ts resolveBankDetails()
-- reads it back at send time to print the chosen bank on the PDF/email. But the OLD
-- CHECK constraint only allowed the five legacy values (auto/relay/mercury/revolut/
-- airwallex) or NULL, so creating an invoice with a configured bank failed with:
--   createTDInvoice[payments.insert]: new row for relation "payments"
--   violates check constraint "payments_bank_preference_check"
--
-- DESIGN: banks are now referenced by a STABLE id — value form `settings_bank:<uuid>` —
-- instead of a fragile list position (`settings_bank_<N>`). Each bank in
-- invoice_settings.bank_accounts carries an `id`; the dialog emits `settings_bank:<id>`,
-- resolveBankDetails looks the bank up by id. This makes reordering/deleting banks safe
-- and fixes a latent index-mismatch bug (the dialog indexed the active-filtered list
-- while the resolver indexed the unfiltered list).
--
-- This constraint accepts: NULL, the five legacy values, and `settings_bank:<uuid>`.
-- Garbage is still rejected (validation preserved).
--
-- SAFETY: strict superset of the old predicate, so no existing row can be invalidated.
-- Verified 2026-06-16: production & sandbox payments.bank_preference contain only
-- NULL/mercury/auto. NOTE: sandbox had NO such constraint at all (schema drift) — this
-- migration also brings sandbox into line with production's intended rule.

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_bank_preference_check;

ALTER TABLE payments ADD CONSTRAINT payments_bank_preference_check
  CHECK (
    bank_preference IS NULL
    OR bank_preference = ANY (ARRAY['auto','relay','mercury','revolut','airwallex']::text[])
    OR bank_preference ~ '^settings_bank:[0-9a-fA-F-]{36}$'
  );
