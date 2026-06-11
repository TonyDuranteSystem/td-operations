# Banking & Bank-Feed Reconciliation
_Last verified against code: 2026-06-11 — Claude (bank_statement_process now runs a post-ingest categorization pass — recategorizeAccountYear: DB rules + transfer-pair matching across the account-year set; summary reports updated count + transfer pairs; failures don't block ingestion. See tax-returns.md Slice 5a.)_
_Prior: 2026-06-11 — Claude (bank_statement_pnl totals now come from the shared `computePnlTotals` in lib/pnl-generator (F1 signed refunds / F3 contribution category — see tax-returns.md); `bank_statement_recategorize` enum gains `contribution`.)_
_Prior: 2026-06-10 — Claude (`bank_statement_process` (lib/mcp/tools/bank-statements.ts) now scans the client's `3.Tax/{tax_year}` subfolder first (falls back to the Tax root for legacy uploads), accepts `.zip` archives, and its filename pattern includes `chase`. Statement parsing itself gained an AI fallback + reconciliation guard — that lives in the Tax Returns subsystem; see `docs/systems/tax-returns.md` gotchas before trusting parsed numbers.)_
_Prior: 2026-06-08 — Claude (matcher now fires the installment handler on a confirmed installment payment — Tax Return Phase 1)_

## What it is
Two related-but-separate systems:
1. **Banking applications** — helping a client open a business bank/fintech account (Relay, Mercury, Revolut, Airwallex). Driven by the banking form + a "Banking Fintech" service delivery.
2. **Bank-feed reconciliation** — auto-matching TD's *own* incoming payments (wires/transfers) to the right TD invoice, marking it paid, and (if it was a signed offer) triggering the client's activation. This is the money-in engine.

Most of the complexity — and bugs — live in #2.

## Bank-feed reconciliation — how it works
1. **Incoming transactions land in `td_bank_feeds`** — synced from Plaid (`lib/plaid-sync.ts`), Airwallex (`lib/airwallex-sync.ts`), or the Banking Circle webhook (`app/api/webhooks/banking-circle/route.ts`). Cron: `app/api/cron/plaid-sync`, `airwallex-sync`, `run-matcher`.
2. **The matcher** `matchAndReconcile(feedId)` in `lib/bank-feed-matcher.ts` compares a feed against:
   - `payments` invoices that are NOT terminal (`Paid`/`Voided`/`Cancelled`), and
   - `pending_activations` with `status='awaiting_payment'`.
   Confidence levels: **exact** (amount within $1/€1), **high** (within 5% + sender name contains the account/client name), **medium** (within 5% only). An **invoice-number reference found in the memo + matching amount is the strongest** match. `STOP_WORDS` strips generic business words ("LLC", "consulting", "wise"…) so names don't cross-match.
3. **On a confident match** → marks the invoice **Paid**, sets the feed `status='matched'`. (It also calls `syncPaymentToQB`, but **QuickBooks is DEAD** — that call is an inert no-op; see "Gotchas" below.)
   - **Installment payments fire the installment handler (Tax Return Phase 1, 2026-06-08).** After marking an **installment** invoice Paid, the matcher dispatches `onInstallmentPaid` (`lib/operations/payment.ts`) — classified via `payment_category` (`isFirstInstallment`/`isSecondInstallment`), guarded to `account_type='Client'`, fire-and-forget so a handler error never rolls back the match. This is what advances the bundle's Tax Return card on a real wire 2nd-installment payment (previously only manual mark-paid / the June cron did, so wire-payers got stranded). See `tax-returns.md`.
4. **The orchestrator** `processBankFeedMatches()` (`lib/operations/process-bank-feed-matches.ts`) walks a batch and, when an invoice with a linked `pending_activation` is auto-paid, runs the activation chain (`runActivation`). Per-feed outcome is one of: `auto_activated`, `needs_review`, `activation_crashed`, `no_match`.
5. **Manual review** for anything not auto-matched: the **`/reconciliation`** page (`matchFeedToInvoice`, `ignoreFeed` in `actions.ts`) + the Finance "Bank Feed" tab; admin actions `bank-feed-confirm-match`, `bank-feed-reject-match`, `bank-feed-retry-activation`.

## Business rules
- **R092** — clients pay TD via the portal; the portal Pay modal shows an **obligatory payment reference (the invoice number)**. That reference is what makes auto-matching reliable — without it, only the amount can match (see the Patrick Covelli case below).
- Invoice payment recording flows through the invoice/billing system (see `billing-invoicing.md`); the matcher uses `syncInvoiceStatus`.

## How it's built
### Key files
- `lib/bank-feed-matcher.ts` → `matchAndReconcile()` (the engine).
- `lib/operations/process-bank-feed-matches.ts` → `processBankFeedMatches()` (batch + activation chain).
- `lib/plaid-sync.ts`, `lib/airwallex-sync.ts`, `app/api/webhooks/banking-circle/route.ts` (feed sources).
- `app/api/cron/run-matcher`, `plaid-sync`, `airwallex-sync` (schedules).
- `app/(dashboard)/reconciliation/{page,actions}.ts`, `app/(dashboard)/bank-feeds/page.tsx` (review UI).
- `app/api/crm/admin-actions/bank-feed-{confirm-match,reject-match,retry-activation}/route.ts`.
- `lib/finance/invoice-party.ts` → `invoicePartyName()` (shows the person's name when the company is blank — contact-scoped invoices).
- Banking applications: `lib/mcp/tools/banking-form.ts` (`banking_form_create/get/review`), `app/banking-form`, "Banking Fintech" SD.

### Tables
`td_bank_feeds` (`status`: matched / ignored / needs_review / activation_crashed; `amount`, `amount_currency`, `sender_reference`, `matched_payment_id`), `payments`, `pending_activations`, plus banking-application records + `service_deliveries` (Banking Fintech).

## Gotchas, invariants & past bugs
- **⚠️ PostgREST enum filtering is unreliable** — `.in()`/`.eq()` on the custom `invoice_status` / currency enums returns wrong rows. The matcher deliberately **fetches broadly and filters status + currency in JS**, using a *blocklist of terminal statuses* (not an allowlist) so a new status never silently drops a matchable invoice. Keep this pattern.
- **Partial invoices** match against `amount_due` (remaining balance), not `total`.
- **`activation_crashed`** feeds are parked in the review queue with a Retry button — the invoice was paid but the downstream activation failed; don't treat as lost.
- **PAST BUG — Patrick Covelli (fixed 2026-05-29):** a third-party payer + a contact-scoped invoice (no company name) + no invoice reference in the memo → only the amount matched → stuck in needs-review, and the manual link UI was company-only. Fix: `invoice-party.ts` surfaces the person's name, the link UI handles contact-scoped invoices, and the portal Pay modal now shows the obligatory wire reference. Root lesson: **the invoice-number reference is the reliable matcher** — push clients to include it.
- **⚰️ QuickBooks is DEAD / decommissioned (kill-switch `QB_ENABLED` OFF since 2026-05-23, dev_task `eca3ce5c`).** `syncPaymentToQB` is still *called* here (and from invoice send and void in `finance/actions.ts` + `invoice-auto-send.ts`), but every function in `lib/qb-sync.ts` early-returns a no-op **before** any DB read/write or QB API call — it syncs nothing, writes nothing, logs nothing. These fire-and-forget calls are harmless leftover plumbing. **Do NOT treat QB as a live part of the system, do NOT build on it, and do NOT try to "complete" or re-enable it.** Removing the plumbing is a separate, planned cleanup — the three callers still `import lib/qb-sync.ts`, so deleting that file naively would break the build.

## How to verify current state
- Read `lib/bank-feed-matcher.ts` (`matchAndReconcile` — confidence tiers + the JS-side status/currency filtering) and `lib/operations/process-bank-feed-matches.ts` (the 4 outcomes).
- Review queue state: `SELECT status, count(*) FROM td_bank_feeds GROUP BY status;`
- A specific feed: `SELECT amount, amount_currency, sender_reference, status, matched_payment_id FROM td_bank_feeds WHERE id='<id>';`
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
