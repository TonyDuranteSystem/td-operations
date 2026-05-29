# Referrals & Circleback
_Last verified against code: 2026-05-29 — Claude (read operations/referral.ts, referral-utils.ts, credit-notes.ts, calendly webhook)_

## What it is
Three related reward/intake flows:
1. **Existing-client referrals** — a current client refers a friend; when that friend pays, the referrer earns a **10% credit note**.
2. **Partner referrals** — partners send clients under a commission model (percentage / price-difference spread / credit note).
3. **Bank referrals** — affiliate links to banks/fintechs (the client applies directly); TD only tracks click-throughs.

"Circleback" is the call-intake side: a referral link leads to a Calendly booking, which auto-creates a lead with referral attribution.

## The existing-client referral flow (the 10% credit)
1. **Referral code** — each client gets one via `ensureReferralCode()` / `generateReferralCode()` (`lib/referral-utils.ts`): `first-last` lowercase, collision suffix. The landing page `app/invitation/[code]` carries it into a Calendly link.
2. **Booking → lead + pending referral** — the Calendly webhook (`app/api/webhooks/calendly/route.ts`) runs in `auto_create` mode (env `CALENDLY_INTAKE_MODE`, default `auto_create`): a booking immediately becomes a lead, and `createPendingReferral()` records the attribution (referral `status='pending'`). `parse-invitee.ts` extracts email/name/phone/language/referral code.
3. **Friend pays → referrer credited** — `creditReferrerForLead()` (`lib/operations/referral.ts`): marks the referral `converted`, links the referred party, then **auto-creates the referrer's reward credit note** = `REFERRAL_COMMISSION_PCT (10)` % of the referred client's **setup fee**. It's created via `createTDInvoice` (negative amount) with `idempotency_key='referral-credit:<referralId>'` and **`skip_credit_netting:true`** (a credit note must not net into itself), tagged `invoice_status='Credit'` with `credit_remaining`. Referral → `status='credited'`, `credited_amount` set.
4. **The credit is consumed** automatically against the referrer's future TD invoices (credit-netting, see `billing-invoicing.md`), or recorded as an explicit `referral_payout` (`credit_note` / `bank_transfer` / `invoice_deduction`). A payout sets the referral `paid` (full) or `credited` (partial).

## Business rules
- **10% of the referred client's setup fee** is the existing-client reward (`REFERRAL_COMMISSION_PCT = 10`, `lib/operations/referral.ts`).
- **Currency (KB Currency Rule):** setup fees are **EUR**, installments **USD**. The 10% is computed on the EUR setup fee total.
- **Commission types** (`calculateCommission` in `referral-utils.ts`): `percentage`/`credit_note` → `pct% × setupFee`; `price_difference` (partners) → `agreedPrice − stateBasePrice`. Base prices (EUR): SMLLC 2500, MMLLC 3000, DE/FL surcharge 300.
- The reward credit note is **idempotent per referral** and **must not net into itself** (`skip_credit_netting`).

## How it's built
### Key files
- `lib/operations/referral.ts` → `REFERRAL_COMMISSION_PCT`, `createPendingReferral()`, `creditReferrerForLead()`.
- `lib/referral-utils.ts` → `generateReferralCode()`, `ensureReferralCode()`, `calculateCommission()`, `BASE_PRICES`.
- `lib/portal/credit-notes.ts` → `createCreditNote()` / `applyCreditNote()` (general two-step credit-note path; `CN-YYYY-NNN`).
- `lib/bank-referrals.ts` → thin queries for `bank_referrals` + `bank_referral_clicks` (untyped — not in generated DB types yet).
- `lib/calendly/parse-invitee.ts`, `app/api/webhooks/calendly/route.ts` — Circleback intake.
- `lib/mcp/tools/referrals.ts` → `referral_create`, `referral_search`, `referral_update`, `referral_tracker`, `referral_payout`, `referral_payouts`.
- `app/invitation/[code]` (landing), `app/portal/referrals` (client view).

### Tables
`referrals` (referrer + referred contact/account/lead, `status` pending→converted→credited→paid, `commission_type`, `commission_pct`, `credited_amount`, `paid_amount`), `referral_payouts`, `bank_referrals` + `bank_referral_clicks`, `payments` (the `Credit` invoices), `client_partners` (partner referrers).

## Gotchas, invariants & past bugs
- **Calendly payload shape:** real Calendly webhooks put invitee fields directly on `payload.payload` (email/name…), NOT under `payload.payload.invitee`. `parse-invitee.ts` handles both; the webhook had a fix for this — don't "simplify" it back. Signature verification (`CALENDLY_WEBHOOK_SECRET`) is enforced.
- **The reward credit note must set `skip_credit_netting`** — otherwise a credit nets into itself. And it's idempotent via `idempotency_key='referral-credit:<id>'`, so re-running `creditReferrerForLead` is safe.
- **Two credit-note creation paths exist:** the general `lib/portal/credit-notes.ts` (`createCreditNote`/`applyCreditNote`, two-step) AND the referral path (`createTDInvoice` negative + `Credit` tag). Don't conflate them.
- **`bank_referrals` tables are untyped** — accessed via a single cast in `lib/bank-referrals.ts`; regenerate types to drop the cast.
- **EUR vs USD** — applying the 10% to a USD installment instead of the EUR setup fee would be wrong; the basis is the setup fee.

## How to verify current state
- Read `lib/operations/referral.ts` (`REFERRAL_COMMISSION_PCT`, `creditReferrerForLead` — the credit-note creation + idempotency + skip-netting) and `lib/referral-utils.ts` (`calculateCommission`, `BASE_PRICES`).
- A referral's state: `SELECT status, commission_type, commission_pct, credited_amount, paid_amount FROM referrals WHERE id='<id>';`
- The reward invoice: `SELECT invoice_number, total, invoice_status, credit_remaining FROM payments WHERE idempotency_key='referral-credit:<id>';`
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
