# Billing & Invoicing
_Last verified against code: 2026-06-01 — Claude (read td-invoice.ts, unified-invoice.ts, invoice-number.ts, credit-netting.ts)_

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
- **Credit netting** — a real (positive, unpaid) TD bill automatically applies the account's outstanding credit notes (oldest first, same currency, capped at the bill) **at invoice-creation time**. Rule lives in code: `lib/operations/credit-netting.ts`.
- **Credit reconciliation (existing invoices, 2026-06-01)** — `reconcileAccountCredits()` applies outstanding credits to an account's ALREADY-EXISTING unpaid invoices (FIFO, same-currency): reduces `amount_due` (keeps `total`), marks Paid when covered, consumes `credit_remaining`, and mirrors the new balance to `client_expenses.amount_due/amount_paid` so the portal shows the net owed. Runs after a credit note / referral credit is created. Complements the at-creation netting above (which only fires when the invoice is first created).
- **Regenerate invoice document (2026-06-02)** — reconcile lowers `amount_due` but leaves the line items showing the full amount (the credit appears only as `amount_paid`). `regenerateInvoice(paymentId)` (`app/(dashboard)/payments/invoice-actions.ts`) rebuilds the document so the credit shows as its own `Credit applied −$X` line, netting `total`/`amount_due` to the amount owed — **in place** (same invoice number, no money moved; the credit was already consumed by reconcile). Generic for ANY account-scoped invoice/service, not installment-specific. The credit shown = `min(gross − amount_due, credit notes linked via credit_for_payment_id)` so a real partial payment is never mistaken for a credit (pure helpers in `lib/portal/invoice-regenerate.ts`, unit-tested). No-op when no credit is linked. UI: "Regenerate" button in `components/payments/invoice-detail-dialog.tsx` (Draft/Sent/Overdue).

## How it's built
### The two creator functions (single entry points)
- **`createTDInvoice()`** in `lib/portal/td-invoice.ts` — TD → client. Writes **`payments`** (primary, staff/QB-facing) + **`payment_items`** + a **`client_expenses`** mirror row (vendor "Tony Durante LLC", its own `EXP-NNNNNN` internal ref) so the client sees the bill as an incoming expense in the portal. Sets `qb_sync_status='pending'`. **Never writes `client_invoices`.**
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
- Currency USD/EUR; `bank_preference` auto/relay/mercury/revolut/airwallex (auto = EUR→Airwallex, USD→Relay).

### Key files
- `lib/portal/td-invoice.ts` (now stamps `client_expenses.amount_due/amount_paid` on the mirror) · `lib/portal/unified-invoice.ts` · `lib/portal/invoice-number.ts` (`generateInvoiceNumber` + `generateCreditNoteNumber`)
- `lib/operations/credit-netting.ts` — `computeCreditApplication`/`consumeCredits` (at-creation) + `reconcileAccountCredits`/`allocateCredits` (existing-invoice reconcile) · `lib/portal/invoice-audit.ts`
- `lib/billing/installment-defaults.ts` · `lib/billing/renewal-guard.ts`
- MCP tools: `portal_invoice_create`, `portal_invoice_send`. CRM: Finance pages, `/payments`, `/invoice-aging`, `/invoice-settings`.

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
