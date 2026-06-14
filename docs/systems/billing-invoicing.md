# Billing & Invoicing
_Last verified against code: 2026-06-12 — Claude (bank_preference now free-form string with three-tier resolution via invoice_settings.bank_accounts; is_default per currency; Invoice Settings UI radio buttons; dialog loads dynamic bank list from /api/invoice-settings)_

## What it is
Everything about money on invoices. There are **four separate money "worlds"** that look similar but must never be mixed up — confusing them is the #1 source of billing bugs:

1. **TD billing the client** — Tony Durante LLC's invoices *to* clients (our revenue). → `payments` table.
2. **The client's own sales** — invoices the client sends to *their* customers (their business, not ours). → `client_invoices` table.
3. **The client's expenses** — what the client owes, including a *mirror* of our TD invoices so they see them in the portal. → `client_expenses` table.
4. **TD's own operating costs** — vendor bills, filing fees, software TD pays. → `td_expenses` table.

## Business rules
- **R027** — `client_invoices` is for the client's sales invoices ONLY. **TD systems NEVER write to it.** (CLAUDE.md)
- **R092** — Invoice emails to clients must send them to the **portal Pay button** to pay. NEVER embed Stripe checkout links, wire details, or payment credentials in the email body. (CLAUDE.md)
- **R098** — Invoice-number generation is race-safe via a DB unique index + caller retry, NOT a code retry/timestamp fallback. Never write `invoice_number` directly — always go through the helper functions. (CLAUDE.md)
- **Credit netting (at invoice-creation only)** — a real (positive, unpaid) TD bill automatically applies the account's outstanding credit notes (oldest first, same currency, capped at the bill) **at invoice-creation time** (`computeCreditApplication`/`consumeCredits`). This is the ONLY remaining automatic credit application; for invoices that already exist, credits apply via click-to-apply Regenerate (below). Rule lives in code: `lib/operations/credit-netting.ts`.
- **Credit application = CLICK-TO-APPLY (2026-06-03)** — credits are NOT auto-applied to existing invoices. A new credit note / referral credit sits as available `credit_remaining` on the account and lands on a SPECIFIC invoice only when staff click **Regenerate** on it (see below). This replaced the old auto-reconcile-onto-oldest behaviour, which made a credit earned in June silently reduce an overdue January invoice (the Wise Strategies bug). `reconcileAccountCredits()` / `allocateCredits()` remain in `credit-netting.ts` but are **NO LONGER CALLED** — do not re-wire them into credit creation.
- **Regenerate invoice document = applies available credit (2026-06-03)** — `regenerateInvoice(paymentId)` (`app/(dashboard)/payments/invoice-actions.ts`) applies the account's available credit to THIS invoice (capped at what it still owes), shows it as a `Credit applied −$X` line, drops `amount_due`, and consumes the credit (stamping `credit_for_payment_id` = this invoice). **The invoice you click is where the credit lands.** In place — same invoice number, no money moved; `amount_paid` tracks REAL cash only (credit is shown purely as the line, never folded into `amount_paid`). Idempotent: a re-click with no remaining available credit re-renders the same document. Generic for ANY account-scoped invoice/service. Pure helpers in `lib/portal/invoice-regenerate.ts` (`computeClickToApplyCredit` etc.), unit-tested; applies/consumes via `computeCreditApplication`/`consumeCredits`. No-op when there is no existing or available credit. UI: Regenerate button on Draft/Sent/Overdue/Partial invoices in the Payment Tracker dialog (`invoice-detail-dialog.tsx`) AND both Finance views (`clients-invoices-tab.tsx`, `all-invoices-tab.tsx`).

## How it's built
### The two creator functions (single entry points)
- **`createTDInvoice()`** in `lib/portal/td-invoice.ts` — TD → client. Writes **`payments`** (primary, staff-facing) + **`payment_items`** + a **`client_expenses`** mirror row (vendor "Tony Durante LLC", its own `EXP-NNNNNN` internal ref) so the client sees the bill as an incoming expense in the portal. Sets `qb_sync_status='pending'` — a **legacy/inert column: QuickBooks is DEAD (decommissioned 2026-05-23), nothing ever reads or advances it**. **Never writes `client_invoices`.**
- **`createUnifiedInvoice()`** in `lib/portal/unified-invoice.ts` — client → their customer. Writes **`client_invoices` only**. No `payments` mirror, no QB sync. Resolves/creates a `client_customers` row.

### Invoice numbers
- `generateInvoiceNumber()` in `lib/portal/invoice-number.ts` — one **global** sequence `INV-NNNNNN`, computed as max+1 across **both** `payments` and `client_invoices` (strict `LIKE 'INV-______'` so legacy oddities don't poison the max). It is intentionally simple and **not race-safe by itself**.
- `generateCreditNoteNumber()` (same file) — separate **`CN-NNNNNN`** sequence (payments-scoped) for **credit notes**, so a credit never reads as an invoice. `createTDInvoice` picks CN- automatically whenever `grossTotal <= 0` (a credit note); INV- otherwise. (Added 2026-06-01.)
- Race safety = partial unique indexes `uq_payments_invoice_number` / `uq_client_invoices_invoice_number` + a **10-attempt retry loop** in the creator functions that regenerates on a 23505 unique-violation. `isUniqueViolation()` detects the specific constraint. **No timestamp-suffix fallback** (that produced the `INV-NNNNNN-XXXXXXXX` scars deleted after the April-12 collision incident — R098).

### Idempotency (content-level dedup)
Both creators accept an optional `idempotency_key`; if a row with that key exists, the existing invoice is returned (no duplicate). `payments` also has `uq_payments_idempotency_key` as a concurrent-insert guard. Standard keys: `offer-signed:TOKEN:CONTACT_ID`, `annual-installment:ACCT:N:YEAR`, `manual-crm:ACCT:HASH`.

### Status & sync
- `payments.status` = Pending/Paid (+ Partial/Overdue/Cancelled/Split); `payments.invoice_status` = Draft/Paid.
- `syncTDInvoiceStatus()` keeps the `client_expenses` mirror in step with the payment (maps payment status → expense status; partial payment stays Pending). `reconcileTDInvoiceMirror()` repairs a drifted mirror.
- `installment` uses `payment_type_enum`: Setup Fee, Installment 1 (Jan), Installment 2 (Jun), Annual Payment, One-Time Service, Custom.
- Currency USD/EUR; `bank_preference` is a free-form string. Three-tier resolution in `lib/invoice-auto-send.ts::resolveBankDetails`: (1) `settings_bank_N` — N-th active bank from `invoice_settings.bank_accounts`; (2) `auto`/null — `is_default` bank from invoice_settings for matching currency, then first bank of that currency, then Mercury/Airwallex fallback; (3) legacy enum (`relay/mercury/revolut/airwallex`) → hardcoded constants. `is_default` is scoped per currency (radio button in Invoice Settings UI). Index N is 0-based into ACTIVE-ONLY banks — both dialog and resolver filter to `active === true` to keep indices aligned.

### Key files
- `lib/portal/td-invoice.ts` (now stamps `client_expenses.amount_due/amount_paid` on the mirror) · `lib/portal/unified-invoice.ts` · `lib/portal/invoice-number.ts` (`generateInvoiceNumber` + `generateCreditNoteNumber`)
- `lib/operations/credit-netting.ts` — `computeCreditApplication`/`consumeCredits` (at-creation) + `reconcileAccountCredits`/`allocateCredits` (existing-invoice reconcile) · `lib/portal/invoice-audit.ts`
- `lib/billing/installment-defaults.ts` · `lib/billing/renewal-guard.ts`
- `lib/invoice-auto-send.ts` — `resolveBankDetails()` (bank resolution at send time), `fetchSettingsBanks()` (active-only from invoice_settings), `sendPaidReceipt()`, `sendInvoiceEmail()`
- MCP tools: `portal_invoice_create`, `portal_invoice_send`. CRM: Finance pages, `/payments`, `/invoice-aging`, `/invoice-settings`.
- `app/(dashboard)/invoice-settings/page.tsx` — Invoice Settings UI with is_default radio buttons per currency
- `components/payments/invoice-dialog.tsx` — dynamic bank dropdown loaded from `/api/invoice-settings`

### Tables
`payments`, `payment_items`, `client_invoices`, `client_invoice_documents`, `client_expenses`, `client_expense_items`, `td_expenses`, `td_expense_items`, `client_customers`, `client_vendors`.

## Gotchas, invariants & past bugs
- **Never write `client_invoices` from any TD/staff flow** (R027) — it's the client's own sales ledger.
- **Never set `invoice_number` directly or add a timestamp fallback** — go through the two creator functions (R098). The April-12 collision came from a fallback format; it was deleted on purpose.
- **`createTDInvoice` is the ONLY entry for new TD invoices** — it deliberately uses raw Supabase (lint rule disabled inline) because the retry loop needs raw error codes that the `dbWrite` wrapper strips.
- **Credit netting is automatic** on real unpaid bills. To create a credit note itself (or any invoice that must not net), pass `skip_credit_netting: true` — otherwise a credit can wrongly net into it. A bill fully covered by credit is marked **Paid, $0 due** with an explicit "service − credit = $0" description.
- **Keep the `client_expenses` mirror in sync** via `syncTDInvoiceStatus` / `reconcileTDInvoiceMirror` — don't update the mirror by hand.
- **Invoice emails → portal Pay only** (R092). No Stripe/wire in the email body.

## How to verify current state
- Read the three creators: `lib/portal/td-invoice.ts` (`createTDInvoice`), `lib/portal/unified-invoice.ts` (`createUnifiedInvoice`), `lib/portal/invoice-number.ts`.
- Confirm the race-safety indexes exist:
  `SELECT indexname FROM pg_indexes WHERE tablename IN ('payments','client_invoices') AND indexname LIKE '%invoice_number%';`
- Confirm the idempotency guard: same query with `LIKE '%idempotency%'` on `payments`.
- Confirm the four worlds are distinct tables: `payments`, `client_invoices`, `client_expenses`, `td_expenses`.
- Note (R096): use the **sandbox** MCP / `psql` for sandbox; production `execute_sql` hits production.
