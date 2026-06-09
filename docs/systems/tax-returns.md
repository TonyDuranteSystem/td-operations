# Tax Returns & Filings
_Last verified against code: 2026-06-09 — Claude (Slices 1–3: tax submission review workflow — `review_status` sub-state on `tax_return_submissions`, 6 new pipeline stages (Data Submitted 45, Under Review 46, Revision Requested 47, Approved 48, Confirmed 49, 2nd Installment Paid 35), gap-renumbered existing stages ×10, SD stays at "Data Submitted" through the whole review loop, only `confirmed` releases forward. Pure state machine in `lib/tax/review-status.ts`. Staff actions: `POST /api/crm/tax-review/action`. Client confirm: `POST /api/portal/tax-confirm` → `applyConfirmedTaxSubmission`. Portal banner (`components/portal/tax-banner.tsx`) now has 7 states driven by `review_status`; `getPortalTaxReturns` now joins the latest submission per account. Migrations: `20260609-2015-tax-review-slice1-columns.sql` + `20260609-2300-tax-pipeline-renumber-review-stages.sql`.)_
_Slice 0: 2026-06-09 — Claude ("Sent to India → Sent to Accountant" rename, Phase 1: new `sent_to_accountant` / `accountant_status` / `sent_to_accountant_date` / `accountant_follow_up_count` columns + `accountant_status` enum + `Sent to Accountant` status label added ALONGSIDE the legacy `india_*` columns and `Sent to India` label; data copied; all code cut over to the new names. Legacy columns NOT dropped yet — Phase 2. Migration split in two files because of Postgres SQLSTATE 55P04. Type bridge: `lib/database.types.augmented.ts`.)_

## What it is
Tracking and filing clients' US tax returns through tax season: collecting their data, sending the package to the accountant, tracking the long status pipeline, handling extensions, and pausing/resuming work tied to installment payments. Return types: **1065** (MMLLC / partnership), **1120-S** (S-corp), **1040NR** (individual non-resident). _(The accountant team was historically referred to in code/UI as "India"; renamed to "Accountant" 2026-06-09 — see header note.)_

## The status pipeline
A tax return moves through a status on `tax_returns.status`. The **current** flow (installment + wizard model) is:
`Payment Pending` → `1st Installment Paid` → `Wizard Available` → `Data Received` → `Sent to Accountant` → `TR Completed - Awaiting Signature` → `TR Filed`, with `Extension Requested` / `Extension Filed` as the extension branch and `Not Invoiced` for un-billed returns. _(`Sent to Accountant` was `Sent to India` until the 2026-06-09 rename; the old label still exists in the `tax_return_status` enum and is kept mapped defensively in code, but the current flow only produces `Sent to Accountant`.)_

> **Legacy statuses — still in the enum, NOT produced by the current flow:** `Activated - Need Link` and `Link Sent - Awaiting Data` are vestiges of the old *"email the client a data link, then wait for their data"* model that predates the installment + wizard redesign. The data link was replaced by the portal wizard, and the old "2nd Installment Paid" stage was renamed "Wizard Available". No tax return currently carries either status, and the pipeline stages that once produced them (`Payment Verified`, `Data Link Sent`) no longer exist. They remain valid enum values — an admin could still set one manually — so they are kept mapped defensively: `lib/operations/tax-return-sd-bridge.ts` aliases both to live SD stages, and the portal pause-banner keeps them in its pre-data-receipt set so a manually-set legacy row still pauses correctly during a tax-season pause. **Do not treat them as live pipeline steps.**

Separately, boolean **workflow-progress flags** track milestones: `paid`, `link_sent`, `data_received`, `sent_to_accountant`, `extension`, `accountant_status`. _(Renamed from `sent_to_india` / `india_status` on 2026-06-09; the legacy columns still exist in the DB until Phase 2 but code no longer reads/writes them.)_

## Tax submission review workflow (Slices 1–3, shipped 2026-06-09)

The client portal wizard submit no longer auto-completes the return. Instead it parks the submission in a **staff review loop** tracked on `tax_return_submissions.review_status`:

```
null → submitted → under_review → approved → confirmed → (releases)
                         ↓                      ↓
                 revision_requested          reopened → submitted
                         ↓
                    resubmitted → under_review
```

- **Pure state machine:** `lib/tax/review-status.ts` — `canTransition`, `isClientEditable`, `advancesServiceDelivery`, `buildReviewHistoryEntry`. Only `confirmed` sets `advancesServiceDelivery=true`.
- **SD stays at "Data Submitted" (stage 45)** through the whole review loop. Only the client's `Confirm` advances the SD to "Data Received" (50) via `lib/tax/apply-confirmed-submission.ts`.
- **`review_history`** (JSONB) on `tax_return_submissions` keeps an immutable log: `{from, to, at, by, actor}` per transition.
- **Staff actions:** `POST /api/crm/tax-review/action` — body `{submission_id, action, note?}`. Valid actions: `start_review`, `approve`, `request_changes` (note required), `reopen`. Each resolves the open What's New card so a re-submission raises a fresh one.
- **Client confirm:** `POST /api/portal/tax-confirm` — only allowed when `review_status=approved`. On success: appends history entry, calls `applyConfirmedTaxSubmission`.
- **Portal banner:** `components/portal/tax-banner.tsx` has 7 client-facing states keyed by `review_status` (null=amber action-required, submitted/resubmitted=blue+Edit, under_review=blue locked, revision_requested=amber+Edit, approved=green+Confirm+Edit, confirmed=blue locked, reopened=amber+Edit). Legacy path for pre-Slice-2 submissions uses `dataReceived`/`sentToAccountant` boolean fallback.
- **New pipeline stages** (migration `20260609-2300-tax-pipeline-renumber-review-stages.sql`):
  - Existing stages ×10 (stage_order -10…90 with gaps)
  - New: `2nd Installment Paid (35)`, `Data Submitted (45)`, `Under Review (46)`, `Revision Requested (47)`, `Approved (48)`, `Confirmed (49)`
- **`getPortalTaxReturns`** (`lib/portal/queries.ts`) now joins the latest submission per account and returns `review_status` + `submission_id` alongside the tax return row.

## The accountant hand-off
- `tax_send_to_accountant` (`lib/mcp/tools/tax.ts`) gathers the document package from Drive `3.Tax/{year}/` — **Tax Organizer PDF, P&L Excel (MMLLC/Corp), prior-year return, bank statements** — and sends one email with all attachments to the accountant (default `tax@adasglobus.com`), then updates the return's status (`status → "Sent to Accountant"`, `accountant_status → "Sent - Pending"`).
- **Always run `dry_run=true` first**, review the package, get Antonio's approval, then run with `dry_run=false`.
- **Idempotent**: skips if already sent (stamps `sent_to_accountant_date`) unless `force_resend=true`.

## Tax pause + installment reactivation
- During tax season, Tax Return service deliveries can be **parked `on_hold`**. The global master switch is `app_settings.tax_season_paused`.
- `reactivateOnHoldTaxReturns()` (`lib/tax/reactivation.ts`) flips an individual `on_hold` Tax Return SD back to `active` **once the client's 2nd installment is paid** — run synchronously from `onSecondInstallmentPaid` (`lib/installment-handler.ts`) and as a daily safety-net cron (`/api/cron/tax-reactivation`).

## 2nd-installment → wizard advance (Phase 1 "Card = Truth", 2026-06-08)
The card now advances to the wizard stage on a **real, bank-confirmed** 2nd-installment payment — fixing the bug where wire-paying clients got stranded pre-wizard (the matcher marked the invoice Paid but nothing fired the stage advance).
- **Trigger:** `matchAndReconcile` (`lib/bank-feed-matcher.ts`) fires `onInstallmentPaid` (`lib/operations/payment.ts`) when it confirms an **installment** invoice Paid — classified via `payment_category` (`isFirstInstallment`/`isSecondInstallment`, `lib/billing/payment-classification.ts`), guarded to `account_type='Client'`, fire-and-forget so a handler error never rolls back the match. (The June `annual-installments` cron + manual CRM mark-paid remain the other entry points.)
- **Advance rule is DATA-DRIVEN — no hardcoded stage names.** `onSecondInstallmentPaid` calls `resolveSecondInstallmentAdvance('Tax Return')` (`lib/services/stages.ts`): the **target** stage is the one flagged `auto_actions: [{ "type": "second_installment_target" }]`, the **source** stages are every stage at `stage_order >= 1` below it (bundle stages — EXCLUDES the negative/zero standalone-intake stages "Company Data Pending"/"Paid - Awaiting Data"). Editable in **/config** (stage edit dialog → "2nd-installment wizard target" checkbox). Fails safe (skips) if no stage is flagged. Marker helpers: `lib/services/stage-actions.ts`.
- **Idempotent:** the handler's lease task + "[READY] Send tax return to Accountant" task now dedup by title, so a second run (matcher + cron/manual) never duplicates them. _(Renamed from "...to India" 2026-06-09; the dedup lookup matches BOTH the new and the legacy title so a task created before the rename is not duplicated during the transition.)_
- **`data_received` always stamps a date.** The dashboard toggle (`app/(dashboard)/tax-returns/actions.ts`) now sets/clears `data_received_date` with the flag. A dateless `data_received=true` is the legacy bug that BLOCKS a client from submitting (`app/api/portal/wizard-submit/route.ts` requires `data_received=false`) and hides their banner — never create one. A backfill cleared the historical dateless flags (`scripts/backfill-tax-data-received-2025.sql`).
- **Silent bulk advances:** `advanceServiceDelivery` (`lib/service-delivery.ts`) accepts `skip_notify` to suppress the portal notification + push for reconciliation/backfills so correcting many cards at once does not spam clients.

## Business rules
- **Send-to-accountant is dry-run-first + approval-gated** (built into the tool's contract) — never blast documents without reviewing the package.
- **Tax pause is gated on the 2nd installment** — a client's tax work resumes when they've paid installment 2, OR when the global pause is lifted.

## How it's built
### Key files
- `lib/mcp/tools/tax.ts` — the bulk: `tax_search`, `tax_tracker`, `tax_update`, `tax_form_create/get/review`, `tax_send_to_accountant`, `tax_extension_list/update`, `tax_return(s)`, `tax_year`.
- `lib/mcp/tools/tax-quote.ts` — `tax_quote_create`, `tax_quote_submissions`.
- `lib/tax/reactivation.ts` — `reactivateOnHoldTaxReturns()` (installment-gated resume).
- `lib/tax/extension-deadline.ts` — `resolveExtensionDeadline()`, `formatDeadlineForDisplay()`.
- `lib/installment-handler.ts` (`onSecondInstallmentPaid`), `app/api/cron/tax-reactivation`.
- Client form: `app/tax-form`. Docs: Google Drive `3.Tax/{year}/`.

### Tables
`tax_returns` (`status`, `deadline`, `return_type`, `tax_year`, `accountant_status`, `sent_to_accountant`, `sent_to_accountant_date`, `accountant_follow_up_count`, extension fields, the workflow-progress booleans — plus the **legacy** `india_status` / `sent_to_india` / `sent_to_india_date` / `india_follow_up_count` columns that still exist until Phase 2 but are no longer used by code), `service_deliveries` (Tax Return SDs, `active`/`on_hold`), tax form submissions, `app_settings` (`tax_season_paused`).

## Gotchas, invariants & past bugs
- **The accountant-workflow fields are `sent_to_accountant` / `accountant_status` / `sent_to_accountant_date` / `accountant_follow_up_count`** (renamed from `india_*` on 2026-06-09). Don't read them as a literal country status. **Two-phase rename in progress:** the legacy `india_*` columns and the `Sent to India` enum label still exist in the DB (for rollback safety) but code reads/writes only the new names; a later Phase 2 migration drops the legacy columns and then `database.types.ts` is regenerated (and `lib/database.types.augmented.ts` + the temporary augmented imports in `supabase-admin.ts` / `pay-token.ts` / `resolve-payment-recipient.ts` are removed). The legacy `Sent to India` label is still mapped defensively in `tax-return-sd-bridge.ts`, `enum-normalization.ts`, the portal queries exclusion list, and `tax.ts` `isInProgress`; the installment-handler accountant task dedups against BOTH the old and new task titles during the transition.
- **The observability trigger** `scripts/sandbox-seed/30-tax-returns-observability.sql` still references `sent_to_india` — it must be recreated against `sent_to_accountant` when the legacy columns are dropped in Phase 2 (not before).
- **Never flip `app_settings.tax_season_paused` to reactivate ONE client** — that reactivates ALL on-hold returns. Use the per-SD installment reactivation (`reactivateOnHoldTaxReturns`) for a single client whose 2nd installment landed while the global pause is still on.
- **`tax_send_to_accountant` is idempotent + dry-run-first** — check the package before sending; re-send needs `force_resend=true`.
- **Status (a long string) and the workflow-progress booleans are separate** — update the right one; don't infer one from the other.
- **Prerequisites for the accountant send**: the tax form must be completed and the documents must already be in the Drive `3.Tax/{year}/` folder, or the package will be incomplete.

## How to verify current state
- Read `lib/mcp/tools/tax.ts` — the `tax_search` status list (authoritative status enum) and `tax_send_to_accountant` (package contents + idempotency).
- Read `lib/tax/reactivation.ts` for the installment-gated resume logic.
- A client's returns: `SELECT tax_year, return_type, status, deadline, sent_to_accountant_date FROM tax_returns WHERE account_id='<id>' ORDER BY tax_year DESC;`
- Pause state: `SELECT value FROM app_settings WHERE key='tax_season_paused';` (verify the exact key in code first).
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
