# Referrals & Circleback
_Last verified against code: 2026-06-01 — Claude (read operations/referral.ts, credit-netting.ts, app/api/referral/manual, referrals page + add-referral-modal, invoice-number.ts)_

## What it is
Reward/intake flows:
1. **Existing-client referrals** — a current client refers a friend; when that friend pays, the referrer earns a **10% credit note**.
2. **Manual referral entry (staff-added)** — staff record a referral directly on the CRM Referrals page (referrer/referred can each be a **contact OR an account/partner**), and the 10% credit is issued immediately. For back-filling or referrals that didn't come through a Calendly link.
3. **Partner referrals** — partners send clients under a commission model (percentage / price-difference spread / credit note).
4. **Bank referrals** — affiliate links to banks/fintechs (the client applies directly); TD only tracks click-throughs.

"Circleback" is the call-intake side: a referral link leads to a Calendly booking, which auto-creates a lead with referral attribution.

## The existing-client referral flow (the 10% credit)
1. **Referral code** — each client gets one via `ensureReferralCode()` / `generateReferralCode()` (`lib/referral-utils.ts`): `first-last` lowercase, collision suffix. The landing page `app/invitation/[code]` carries it into a Calendly link.
2. **Booking → lead + pending referral** — the Calendly webhook (`app/api/webhooks/calendly/route.ts`) runs in `auto_create` mode (env `CALENDLY_INTAKE_MODE`, default `auto_create`): a booking immediately becomes a lead, and `createPendingReferral()` records the attribution (referral `status='pending'`). `parse-invitee.ts` extracts email/name/phone/language/referral code.
3. **Friend pays → referrer credited** — `creditReferrerForLead()` (`lib/operations/referral.ts`): marks the referral `converted`, links the referred party, then **auto-creates the referrer's reward credit note** = `REFERRAL_COMMISSION_PCT (10)` % of the referred client's **setup fee**. It's created via `createTDInvoice` (negative amount) with `idempotency_key='referral-credit:<referralId>'` and **`skip_credit_netting:true`** (a credit note must not net into itself), tagged `invoice_status='Credit'` with `credit_remaining`. Referral → `status='credited'`, `credited_amount` set.
4. **The credit is consumed** automatically against the referrer's future TD invoices (credit-netting, see `billing-invoicing.md`), or recorded as an explicit `referral_payout` (`credit_note` / `bank_transfer` / `invoice_deduction`). A payout sets the referral `paid` (full) or `credited` (partial).

## The manual referral flow (staff "Add referral", 2026-06-01)
1. **Entry** — CRM `/referrals` page → **"Add referral"** button → modal (`app/(dashboard)/referrals/add-referral-modal.tsx`). Both the **referrer** ("who gets the credit") and the **referred client** are searched across the **full actor space** — accounts of any type (Client, **Partner**, One-Time) AND contacts — via `GET /api/referral/manual?q=`.
2. **Amount** — defaults to **10% of the referred client's setup fee** (`defaultReferralCreditUsd()`), **editable** (manual override allowed).
3. **Create** — `POST /api/referral/manual` → `createManualReferralCredit()` (`lib/operations/referral.ts`): credits the **chosen entity directly** (account → account-scoped credit; contact → contact-scoped — NO silent contact→account resolution), creates the USD credit note via `createTDInvoice` (idempotency `manual-referral:<ref>:<referred>`, `skip_credit_netting`), tags `invoice_status='Credit'`, inserts the `referrals` row `status='credited'` with `referrer_type` partner/client. Guards: positive amount, both parties present, no self-referral, dedup per (referrer, referred).
4. **Auto-reconcile** — after the credit is created, `reconcileAccountCredits()` runs (see below) so the credit immediately lowers the referrer account's existing unpaid invoices.

## Credit reconciliation against existing invoices (2026-06-01)
`reconcileAccountCredits(accountId)` (`lib/operations/credit-netting.ts`) applies an account's outstanding credits to its **existing unpaid invoices** — FIFO, same-currency (pure `allocateCredits()` does the math, unit-tested): reduces each invoice's `amount_due` (keeps `total`), marks it Paid when fully covered, consumes `credit_remaining`, and **mirrors the new balance onto `client_expenses` (`amount_due`/`amount_paid`)** so the client portal shows the net owed. Runs after `createManualReferralCredit` and `createCreditNote`. (The pre-existing netting in `createTDInvoice` only applies credits at invoice-creation time; this handles credits added *after* an invoice exists.)

## Business rules
- **10% of the referred client's setup fee** is the existing-client reward (`REFERRAL_COMMISSION_PCT = 10`, `lib/operations/referral.ts`).
- **Reward currency = USD.** The 10% is taken **directly as USD from the setup-fee number, no FX** (e.g. €2,000 setup → **$200** credit), so it nets against the referrer's USD installments (per Antonio 2026-05-27; comment in `creditReferrerForLead`). Setup fees themselves are EUR.
- **Credit-note numbering = `CN-NNNNNN`** (not `INV-`): `generateCreditNoteNumber()` (`lib/portal/invoice-number.ts`); `createTDInvoice` uses it whenever `grossTotal <= 0` (a credit note), covering both the manual New-Credit-Note button and referral credits.
- **Commission types** (`calculateCommission` in `referral-utils.ts`): `percentage`/`credit_note` → `pct% × setupFee`; `price_difference` (partners) → `agreedPrice − stateBasePrice`. Base prices (EUR): SMLLC 2500, MMLLC 3000, DE/FL surcharge 300.
- The reward credit note is **idempotent per referral** and **must not net into itself** (`skip_credit_netting`).

## How it's built
### Key files
- `lib/operations/referral.ts` → `REFERRAL_COMMISSION_PCT`, `createPendingReferral()`, `creditReferrerForLead()`, **`createManualReferralCredit()`**, **`defaultReferralCreditUsd()`** (pure, unit-tested).
- `lib/operations/credit-netting.ts` → `computeCreditApplication()`/`consumeCredits()` (at-creation netting) + **`reconcileAccountCredits()`** and pure **`allocateCredits()`** (apply credits to existing unpaid invoices).
- `lib/portal/invoice-number.ts` → `generateInvoiceNumber()` (INV-) + **`generateCreditNoteNumber()`** (CN-).
- `app/api/referral/manual/route.ts` → GET unified actor search (accounts+contacts, with setup-fee), POST create (dashboard-only).
- `app/(dashboard)/referrals/add-referral-modal.tsx` → the "Add referral" modal; `referrals-dashboard.tsx` renders per-row + per-currency (`fmtByCur`) amounts; `page.tsx` builds per-currency aggregates.
- `lib/referral-utils.ts` → `generateReferralCode()`, `ensureReferralCode()`, `calculateCommission()`, `BASE_PRICES`.
- `lib/portal/credit-notes.ts` → `createCreditNote()` / `applyCreditNote()` (general two-step credit-note path; `CN-YYYY-NNN`).
- `lib/bank-referrals.ts` → thin queries for `bank_referrals` + `bank_referral_clicks` (untyped — not in generated DB types yet).
- `lib/calendly/parse-invitee.ts`, `app/api/webhooks/calendly/route.ts` — Circleback intake.
- `lib/mcp/tools/referrals.ts` → `referral_create`, `referral_search`, `referral_update`, `referral_tracker`, `referral_payout`, `referral_payouts`.
- `app/invitation/[code]` (landing), `app/portal/referrals` (client view).

### Tables
`referrals` (referrer + referred contact/account/lead, `status` pending→converted→credited→paid, `commission_type`, `commission_pct`, `commission_currency`, `credited_amount`, `paid_amount`), `referral_payouts`, `bank_referrals` + `bank_referral_clicks`, `payments` (the `Credit` invoices, `credit_remaining`), `client_expenses` (portal mirror — now carries `amount_due`/`amount_paid` for partial balances after reconcile), `client_partners` (partner referrers).

## Gotchas, invariants & past bugs
- **Calendly payload shape:** real Calendly webhooks put invitee fields directly on `payload.payload` (email/name…), NOT under `payload.payload.invitee`. `parse-invitee.ts` handles both; the webhook had a fix for this — don't "simplify" it back. Signature verification (`CALENDLY_WEBHOOK_SECRET`) is enforced.
- **The reward credit note must set `skip_credit_netting`** — otherwise a credit nets into itself. And it's idempotent via `idempotency_key='referral-credit:<id>'`, so re-running `creditReferrerForLead` is safe.
- **Two credit-note creation paths exist:** the general `lib/portal/credit-notes.ts` (`createCreditNote`/`applyCreditNote`, two-step) AND the referral path (`createTDInvoice` negative + `Credit` tag). Don't conflate them.
- **`bank_referrals` tables are untyped** — accessed via a single cast in `lib/bank-referrals.ts`; regenerate types to drop the cast.
- **EUR vs USD** — the reward *basis* is the EUR setup-fee number, but the *credit is issued in USD* (the 10% number taken directly, no FX) so it nets against USD installments. Don't "convert."
- **Credit notes are `CN-`, not `INV-`** — `createTDInvoice` branches on `grossTotal <= 0`. Don't route credit notes through `generateInvoiceNumber()`. The referrals dashboard shows **each row's own currency** (and per-currency summary totals via `fmtByCur`) — never hardcode one symbol (USD + EUR commissions coexist).
- **Manual referral credits the CHOSEN actor directly** — picking a contact credits the contact; picking the account credits the account. No auto contact→account resolution (Antonio: staff choose who gets the credit).
- **`reconcileAccountCredits` reduces `amount_due`, keeps `total`**, and must mirror to `client_expenses.amount_due/amount_paid` or the portal still shows the gross. It applies only to a credit's own referrer/account, not all invoices.

## How to verify current state
- Read `lib/operations/referral.ts` (`REFERRAL_COMMISSION_PCT`, `creditReferrerForLead` — the credit-note creation + idempotency + skip-netting) and `lib/referral-utils.ts` (`calculateCommission`, `BASE_PRICES`).
- A referral's state: `SELECT status, commission_type, commission_pct, credited_amount, paid_amount FROM referrals WHERE id='<id>';`
- The reward invoice: `SELECT invoice_number, total, invoice_status, credit_remaining FROM payments WHERE idempotency_key LIKE 'referral-credit:%' OR idempotency_key LIKE 'manual-referral:%';` (credit notes should be `CN-`).
- Manual flow / reconcile: read `createManualReferralCredit` + `reconcileAccountCredits`/`allocateCredits` (`lib/operations/credit-netting.ts`) and `generateCreditNoteNumber` (`lib/portal/invoice-number.ts`). After a credit, the referrer's unpaid invoice `amount_due` should drop (total unchanged) and `client_expenses.amount_due` mirror it.
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
