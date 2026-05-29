# Compliance, Renewals & Deadlines
_Last verified against code: 2026-05-29 — Claude (read harbor-compliance/client.ts, ra-renewal-check cron, service-delivery.ts)_

## What it is
Keeping clients' companies in good standing: the Harbor Compliance integration (registered agent + state filings), the recurring renewals (RA renewal, state annual report), the deadline register, and the calendar.

## Harbor Compliance (HC) integration
- HC is the external provider for **registered agent** and **state filings**. `lib/harbor-compliance/client.ts` is an OAuth2 (password-grant + refresh) REST client. Env: `HC_CLIENT_ID/SECRET/USERNAME/PASSWORD`, `HC_API_BASE_URL` (default `harborcompliance.com/api/v1`).
- Client methods: `listAccounts/Companies`, `createOrder`, `getOrder`, `updateOrder`, `listDeliveries`, `downloadDeliveryFile`, registered-agent change, license sync.
- MCP tools: `hc_list_companies`/`hc_companies`/`hc_company_id`, `hc_get_order`/`hc_orders`, `hc_list_deliveries`/`hc_deliveries`/`hc_download_delivery`, `hc_list_licenses`, `hc_submit_ra_change`, `hc_sync_company`, `hc_sync_license_deadlines`.

## Renewals (date-driven, cron-created)
Recurring obligations are driven by **account-level dates**, and a nightly cron materializes the work:
- **RA Renewal** — `accounts.ra_renewal_date`; cron `app/api/cron/ra-renewal-check` (daily 9am UTC): scans active **Client** accounts where the date is within 30 days, creates a "State RA Renewal" SD + a task for Luca (if not already created). **Skips** accounts with an active Company Closure / Client Offboarding. **Blocked if the 1st installment is unpaid** → task to Antonio (SOP RA Renewal **v7.1**: "no service if first installment unpaid", Antonio 2026-05-05, overrides the old "non-postponable" v7.0).
- **State Annual Report** — `accounts.annual_report_due_date`; cron `annual-report-check` (analogous).
- `RENEWAL_DATE_COLUMN` (`lib/operations/service-delivery.ts`) maps `service_type` → the account date column the cron reads; `isRenewalServiceType()` gates renewal-specific behaviour.
- **Annual Renewal billing** is separate: crons `annual-installments` + `annual-renewal-msa`. **Annual Renewal is a billing cycle, NOT a service delivery** (R106).

## Deadlines & calendar
- **Deadlines** — the `deadlines` table (477+ records: tax filings, annual reports, RA renewals) with status tracking. Tools: `deadline_search`, `deadline_upcoming`, `deadline_update`, `deadline_type`.
- **Calendar** — `calendar_create/update/delete/list_event`, `calendar_find_free_slots` (`lib/mcp/tools/calendar.ts`); the CRM calendar surfaces RA-renewal + annual-report dates (calendar ↔ tracker integration).

## Business rules
- **RA Renewal v7.1:** no service if the 1st installment is unpaid — the cron raises a task to Antonio instead of auto-servicing.
- **Annual Renewal ≠ SD** — it's a billing cycle (R106); don't create a service delivery for it.
- **Renewal SDs are re-created nightly** from the account date — clearing/zeroing the account date is the only way to permanently stop the cron.
- Skip renewal creation when a Closure / Offboarding is active (a leaving client shouldn't be renewed).

## How it's built — key files & tables
- Files: `lib/harbor-compliance/{client,index,types}.ts`, `lib/mcp/tools/{harbor-compliance,deadlines,calendar}.ts`, `app/api/cron/{ra-renewal-check,annual-report-check,annual-installments,annual-renewal-msa}/route.ts`, `lib/operations/service-delivery.ts` (`RENEWAL_DATE_COLUMN`, `deactivateSD` `clear_renewal_date`).
- Tables: `deadlines`, `accounts` (`ra_renewal_date`, `annual_report_due_date`), `service_deliveries` (State RA Renewal / State Annual Report), `tasks`. HC data is external (synced in).

## Gotchas, invariants & past bugs
- **A renewal SD you cancel will come back tomorrow** unless you clear the account date — `deactivateSD({ clear_renewal_date: true })` clears `ra_renewal_date`/`annual_report_due_date` so the nightly cron stops re-creating it. Deactivating without that flag = the SD reappears.
- **Unpaid 1st installment blocks RA renewal** (v7.1) — the work is NOT auto-created; a task goes to Antonio. Don't assume an overdue client got renewed.
- **Annual Renewal is billing, not an SD** — creating an SD for it is wrong (R106).
- **HC is an external API** — failures are network/auth (OAuth2 creds); `hc_sync_*` pulls HC state into the CRM, it's not the source of truth for our pipeline.

## How to verify current state
- Read `app/api/cron/ra-renewal-check/route.ts` (the 30-day scan + unpaid-installment block), `lib/operations/service-delivery.ts` (`RENEWAL_DATE_COLUMN`, `clear_renewal_date`), `lib/harbor-compliance/client.ts`.
- Upcoming renewals: `SELECT company_name, ra_renewal_date, annual_report_due_date FROM accounts WHERE ra_renewal_date <= now() + interval '30 days' OR annual_report_due_date <= now() + interval '30 days';`
- Deadlines: `SELECT deadline_type, due_date, status FROM deadlines WHERE account_id='<id>' ORDER BY due_date;`
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
