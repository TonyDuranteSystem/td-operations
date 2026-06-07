# Tax Returns & Filings
_Last verified against code: 2026-06-07 — Claude (verified status pipeline against live tax_returns counts + pipeline_stages; flagged "Activated - Need Link" / "Link Sent - Awaiting Data" as legacy via tax-return-sd-bridge.ts + service-delivery.ts inverse map)_

## What it is
Tracking and filing clients' US tax returns through tax season: collecting their data, sending the package to the accountant ("India" team), tracking the long status pipeline, handling extensions, and pausing/resuming work tied to installment payments. Return types: **1065** (MMLLC / partnership), **1120-S** (S-corp), **1040NR** (individual non-resident).

## The status pipeline
A tax return moves through a status on `tax_returns.status`. The **current** flow (installment + wizard model) is:
`Payment Pending` → `1st Installment Paid` → `Wizard Available` → `Data Received` → `Sent to India` → `TR Completed - Awaiting Signature` → `TR Filed`, with `Extension Requested` / `Extension Filed` as the extension branch and `Not Invoiced` for un-billed returns.

> **Legacy statuses — still in the enum, NOT produced by the current flow:** `Activated - Need Link` and `Link Sent - Awaiting Data` are vestiges of the old *"email the client a data link, then wait for their data"* model that predates the installment + wizard redesign. The data link was replaced by the portal wizard, and the old "2nd Installment Paid" stage was renamed "Wizard Available". No tax return currently carries either status, and the pipeline stages that once produced them (`Payment Verified`, `Data Link Sent`) no longer exist. They remain valid enum values — an admin could still set one manually — so they are kept mapped defensively: `lib/operations/tax-return-sd-bridge.ts` aliases both to live SD stages, and the portal pause-banner keeps them in its pre-data-receipt set so a manually-set legacy row still pauses correctly during a tax-season pause. **Do not treat them as live pipeline steps.**

Separately, boolean **workflow-progress flags** track milestones: `paid`, `link_sent`, `data_received`, `sent_to_india`, `extension`, `india_status`.

## The accountant ("India") hand-off
- `tax_send_to_accountant` (`lib/mcp/tools/tax.ts`) gathers the document package from Drive `3.Tax/{year}/` — **Tax Organizer PDF, P&L Excel (MMLLC/Corp), prior-year return, bank statements** — and sends one email with all attachments to the accountant (default `tax@adasglobus.com`), then updates the return's status.
- **Always run `dry_run=true` first**, review the package, get Antonio's approval, then run with `dry_run=false`.
- **Idempotent**: skips if already sent (stamps `sent_to_india_date`) unless `force_resend=true`.

## Tax pause + installment reactivation
- During tax season, Tax Return service deliveries can be **parked `on_hold`**. The global master switch is `app_settings.tax_season_paused`.
- `reactivateOnHoldTaxReturns()` (`lib/tax/reactivation.ts`) flips an individual `on_hold` Tax Return SD back to `active` **once the client's 2nd installment is paid** — run synchronously from `onSecondInstallmentPaid` (`lib/installment-handler.ts`) and as a daily safety-net cron (`/api/cron/tax-reactivation`).

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
`tax_returns` (`status`, `deadline`, `return_type`, `tax_year`, `india_status`, `sent_to_india_date`, extension fields, the workflow-progress booleans), `service_deliveries` (Tax Return SDs, `active`/`on_hold`), tax form submissions, `app_settings` (`tax_season_paused`).

## Gotchas, invariants & past bugs
- **"India" = the accountant.** `sent_to_india` / `india_status` / `sent_to_india_date` are the accountant-workflow fields (legacy naming). Don't read them as a literal country status.
- **Never flip `app_settings.tax_season_paused` to reactivate ONE client** — that reactivates ALL on-hold returns. Use the per-SD installment reactivation (`reactivateOnHoldTaxReturns`) for a single client whose 2nd installment landed while the global pause is still on.
- **`tax_send_to_accountant` is idempotent + dry-run-first** — check the package before sending; re-send needs `force_resend=true`.
- **Status (a long string) and the workflow-progress booleans are separate** — update the right one; don't infer one from the other.
- **Prerequisites for the accountant send**: the tax form must be completed and the documents must already be in the Drive `3.Tax/{year}/` folder, or the package will be incomplete.

## How to verify current state
- Read `lib/mcp/tools/tax.ts` — the `tax_search` status list (authoritative status enum) and `tax_send_to_accountant` (package contents + idempotency).
- Read `lib/tax/reactivation.ts` for the installment-gated resume logic.
- A client's returns: `SELECT tax_year, return_type, status, deadline, sent_to_india_date FROM tax_returns WHERE account_id='<id>' ORDER BY tax_year DESC;`
- Pause state: `SELECT value FROM app_settings WHERE key='tax_season_paused';` (verify the exact key in code first).
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
