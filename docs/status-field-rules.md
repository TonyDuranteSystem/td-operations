# Status Field Rules -- td-operations

**Audience**: Every developer (human and AI) who writes to any status column in this database.
**Authority**: These rules are MANDATORY. Violations cause invisible data corruption, ghost records, and broken pipelines.
**Date**: 2026-04-08 (derived from full database audit)

---

## Why These Rules Exist

The audit found:

- **ZERO** write paths import `SERVICE_STATUS` from `lib/constants.ts` -- every actor hardcodes strings.
- **30+ tables** use TEXT for status with no DB CHECK constraints.
- **Case mismatches** in production data: `"Cancelled"` vs `"cancelled"`, `"Completed"` vs `"completed"`, `"todo"` vs `"To Do"`.
- **Ghost ENUMs**: `offer_status` ENUM exists in DB but `offers.status` is VARCHAR with different values.
- **`crm_update_record`** (`lib/mcp/tools/crm.ts:753`) accepts any string for any of 11 tables -- zero validation.
- **19+ distinct actors** (crons, webhooks, MCP tools, API routes, UI components) write to `service_deliveries` alone.

---

## Rule 1: Canonical Status Values

Every table with a status column has exactly ONE set of allowed values. The canonical case is shown below. Any write that does not match this EXACT casing will be rejected by the CHECK constraint (once deployed) or must be treated as a bug.

### accounts.status
```
'Active', 'Pending Formation', 'Delinquent', 'Suspended', 'Cancelled', 'Closed'
```
Constant: `ACCOUNT_STATUS` in `lib/constants.ts:3`

### contacts.status
```
'active', 'inactive'
```
Constant: **MISSING from constants.ts -- must be added**

### leads.status
```
'New', 'Call Scheduled', 'Call Done', 'Offer Sent', 'Negotiating', 'Converted', 'Lost', 'Suspended'
```
Constant: `LEAD_STATUS` in `lib/constants.ts:27`

### deals.stage
```
'Initial Consultation', 'Offer Sent', 'Negotiation', 'Agreement Signed', 'Paid', 'Closed Won', 'Closed Lost'
```
Constant: `DEAL_STAGE` in `lib/constants.ts:22`

### tasks.status
```
'To Do', 'In Progress', 'Waiting', 'Done', 'Cancelled'
```
Constant: `TASK_STATUS` in `lib/constants.ts:38`
**Known bug**: Whop webhook (`app/api/webhooks/whop/route.ts:377,389`) writes `"todo"` instead of `"To Do"`.

### payments.status
```
'Pending', 'Paid', 'Overdue', 'Delinquent', 'Waived', 'Refunded'
```
Constant: `PAYMENT_STATUS` in `lib/constants.ts:30`
**Known bug**: `overdue-payments-report` cron (`app/api/cron/overdue-payments-report/route.ts:33`) reads `.eq("status", "overdue")` -- should be `"Overdue"`.

### payments.invoice_status
```
'Draft', 'Sent', 'Overdue', 'Partial', 'Paid', 'Void'
```
Constant: **MISSING from constants.ts -- must be added**

### service_deliveries.status
```
'active', 'blocked', 'completed', 'cancelled'
```
Constant: **MUST REPLACE** current `SERVICE_STATUS` (which uses Title Case: `'Not Started'`, `'In Progress'`, `'Completed'`, `'Cancelled'`). Production data already uses lowercase. The constant must be updated to match.

### service_deliveries.stage
```
Free text -- governed by pipeline_stages table per service_type.
```
No CHECK constraint needed on stage itself; validation happens via pipeline_stages FK lookup.

### offers.status
```
'draft', 'sent', 'viewed', 'accepted', 'signed', 'completed', 'rejected', 'expired', 'negotiating'
```
Constant: Current `OFFER_STATUS` (`lib/constants.ts:67`) uses Title Case but production data is lowercase. **Must be updated to lowercase.**
**Ghost ENUM**: A DB ENUM `offer_status` exists with different values. It is NOT used by the `offers.status` column (VARCHAR). The ENUM should be dropped.

### tax_returns.status
```
'Payment Pending', 'Link Sent - Awaiting Data', 'Data Received', 'Sent to India', 'Extension Filed', 'TR Completed - Awaiting Signature', 'TR Filed'
```
Constant: `TAX_RETURN_STATUS` in `lib/constants.ts:53`

### pending_activations.status
```
'awaiting_payment', 'payment_confirmed', 'activating', 'activated', 'failed'
```
Constant: **MISSING from constants.ts -- must be added**

### conversations.status
```
'New', 'Proposed', 'Approved', 'Sent', 'Archived'
```
Constant: `CONVERSATION_STATUS` in `lib/constants.ts:63`

### client_invoices.status
```
'Draft', 'Sent', 'Overdue', 'Partial', 'Paid', 'Void'
```
Constant: **MISSING from constants.ts -- must be added** (can share `INVOICE_STATUS` with `payments.invoice_status`)

### dev_tasks.status
```
'todo', 'in_progress', 'done', 'blocked'
```
Constant: **MISSING from constants.ts -- must be added**

### form submission tables (banking_submissions, formation_submissions, onboarding_submissions, tax_quote_submissions, tax_return_submissions, closure_submissions, itin_submissions, ss4_applications, form_8832_applications)
```
'draft', 'submitted', 'in_review', 'approved', 'rejected'
```
Constant: **MISSING from constants.ts -- must be added as `FORM_SUBMISSION_STATUS`**

### lease_agreements.status
```
'draft', 'sent', 'signed', 'active', 'expired', 'terminated'
```
Constant: **MISSING from constants.ts -- must be added**

### signature_requests.status
```
'pending', 'signed', 'expired', 'cancelled'
```
Constant: **MISSING from constants.ts -- must be added**

### webhook_events.status
```
'received', 'processed', 'failed'
```
Constant: **MISSING from constants.ts -- must be added**

### job_queue.status
```
'pending', 'running', 'completed', 'failed'
```
Constant: **MISSING from constants.ts -- must be added**

---

## Rule 2: Writing to Status Fields

### NEVER hardcode status strings

```typescript
// WRONG -- hardcoded string
await supabase.from("tasks").insert({ status: "todo" })

// CORRECT -- import from constants
import { TASK_STATUS } from "@/lib/constants"
await supabase.from("tasks").insert({ status: TASK_STATUS[0] }) // "To Do"
```

### constants.ts is the source of truth for application code

- `lib/constants.ts` MUST be updated to include ALL table statuses listed in Rule 1.
- Every write path (API route, cron job, webhook handler, MCP tool, UI component) MUST import from `lib/constants.ts`.
- If a value is not in the constant array, the code must not write it.

### crm_update_record must validate

`lib/mcp/tools/crm.ts:761` currently does:
```typescript
const { data, error } = await supabaseAdmin
  .from(table)
  .update({ ...updates, updated_at: new Date().toISOString() })
```

This accepts ANY string for status. It MUST be changed to validate `updates.status` (if present) against the appropriate constant for that table before writing.

### Existing schemas MUST be used

These Zod schemas already exist and validate status:
- `lib/schemas/task.ts` -- uses `TASK_STATUS`
- `lib/schemas/payment.ts` -- uses `PAYMENT_STATUS`
- `lib/schemas/service.ts` -- uses `SERVICE_STATUS`
- `lib/schemas/deal.ts` -- uses `DEAL_STAGE`
- `lib/schemas/account.ts` -- uses `ACCOUNT_STATUS`

Every INSERT or UPDATE that goes through an API route or server action MUST parse through the appropriate schema. Direct Supabase calls that bypass schemas are bugs unless they are in a webhook/cron with documented reasons.

---

## Rule 3: Adding New Tables with Status Columns

Every new table with a status column MUST have all four:

1. **DB CHECK constraint** -- added at table creation time:
   ```sql
   ALTER TABLE new_table
     ADD CONSTRAINT new_table_status_check
     CHECK (status IN ('value1', 'value2', 'value3'));
   ```

2. **constants.ts entry** -- added before deploying the code:
   ```typescript
   export const NEW_TABLE_STATUS = ['value1', 'value2', 'value3'] as const
   export type NewTableStatus = (typeof NEW_TABLE_STATUS)[number]
   ```

3. **Zod schema** -- created in `lib/schemas/`:
   ```typescript
   import { NEW_TABLE_STATUS } from "@/lib/constants"
   export const createNewTableSchema = z.object({
     status: z.enum(NEW_TABLE_STATUS).default('value1'),
   })
   ```

4. **Audit health check** -- the table must be added to the audit query that checks for orphaned/invalid status values.

---

## Rule 4: Adding New Status Values to Existing Tables

**Deployment order matters.** A wrong order will cause either insert failures or constraint violations.

1. Update `lib/constants.ts` -- add the new value to the array
2. Update the Zod schema in `lib/schemas/` -- it will pick up the new constant automatically
3. Deploy the code changes (the app can now write the new value)
4. `ALTER TABLE` to add the value to the CHECK constraint:
   ```sql
   ALTER TABLE table_name DROP CONSTRAINT table_name_status_check;
   ALTER TABLE table_name ADD CONSTRAINT table_name_status_check
     CHECK (status IN ('old1', 'old2', 'new_value'));
   ```
5. Update the audit health check query

**NEVER** add a constraint value to the DB without updating the code first -- or the old code will continue writing the old (now-missing) values and fail.

**NEVER** add a code value without eventually adding it to the constraint -- or you will have unvalidated data.

---

## Rule 5: New MCP Tools or API Routes

Before any new tool or route goes live, verify:

1. Does this code write to any status column?
2. If yes: does it import the value from `lib/constants.ts`?
3. If it reads status for filtering: does the case match the canonical value from Rule 1?
4. Is there a Zod schema validating the input?

A PR that writes a hardcoded status string MUST be rejected.

---

## Rule 6: RLS Policy Rules

### NEVER create a policy with `qual = 'true'` on role `{public}` or `{anon}` for tables containing client data

The audit found:
- **11 "service_role" policies** accidentally assigned to `{public}` role with `qual = true` -- meaning ANY unauthenticated request can read/write these tables.
- **14 tables** with `anon`/`public` SELECT+UPDATE `qual = true` -- form submission tables that should require token validation.
- **4 tables** with zero RLS enabled on sensitive financial data (`client_bank_accounts`, `bank_transactions`, `plaid_connections`, `oauth_tokens`).

### Rules:

- **Token-based access** (forms, offers, leases): The RLS policy `qual` MUST include token validation, not just `true`. Example:
  ```sql
  CREATE POLICY "anon_read_via_token" ON offers
    FOR SELECT TO anon
    USING (token = current_setting('request.headers', true)::json->>'x-form-token');
  ```
- **Client-facing tables** (payments, service_deliveries, tasks visible in portal): Must use `get_client_account_ids()` or `auth.uid()` to scope data to the logged-in user.
- **All new tables** must have `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` at creation time.
- **service_role bypass**: Only the `service_role` role should bypass RLS. Policies granting access to `{public}` with `qual = true` are security vulnerabilities.

---

## Rule 7: Webhook Handlers

### Authentication
Every webhook endpoint MUST validate the incoming request:
- **Whop**: Standard Webhooks signature verification (already done in `app/api/webhooks/whop/route.ts:29-96`)
- **Stripe**: Stripe signature verification via `stripe.webhooks.constructEvent()`
- **Internal** (offer-signed, brain): `CRON_SECRET` or `API_SECRET_TOKEN` Bearer validation
- **NEVER** accept unauthenticated POSTs -- the offer-signed webhook (`app/api/webhooks/offer-signed/route.ts`) currently has NO auth check.

### Idempotency
Every webhook MUST check for existing records before creating:
```typescript
// CORRECT -- check before insert
const { data: existing } = await supabase
  .from("pending_activations")
  .select("id")
  .eq("offer_token", offer_token)
  .limit(1)
if (existing?.length) return { ok: true, message: "Already pending" }
```

### Fallback tasks
If the downstream action fails (e.g., activate-service errors, Drive upload fails), the webhook MUST create a fallback task assigned to Antonio with priority "Urgent".

### Status values
All status values written by webhooks MUST match the constants from Rule 1. The Whop webhook currently writes `"todo"` (lines 377, 389) instead of `"To Do"`.

---

## Rule 8: Cron Jobs

### Logging
Every cron MUST log to `cron_log` on both success and error:
```typescript
await supabase.from("cron_log").insert({
  endpoint: "/api/cron/my-cron",
  status: "success", // or "error"
  details: { count, results },
  error_message: null, // or error.message
  executed_at: new Date().toISOString(),
})
```

The following crons are currently MISSING cron_log writes (discovered in audit):
- `overdue-payments-report`
- `email-monitor`
- `deadline-reminders`
- `wizard-reminders`
- `portal-issues`
- `annual-installments`
- `invoice-overdue`
- `portal-recurring-invoices`
- `portal-digest`
- `mercury-sync`

### vercel.json registration
Every cron MUST be listed in `vercel.json`. Currently missing:
- `portal-recurring-invoices` (the cron file exists at `app/api/cron/portal-recurring-invoices/route.ts` but has no entry in `vercel.json`)

### Status string case
When a cron reads status for filtering (e.g., `.eq("status", "overdue")`), the case MUST match the canonical value from Rule 1. The overdue-payments-report cron uses lowercase `"overdue"` but the canonical payment status is `"Overdue"`.

---

## Quick Reference: Where Constants Live

| Table | Constant Name | File:Line | Schema File |
|-------|--------------|-----------|-------------|
| accounts | `ACCOUNT_STATUS` | `lib/constants.ts:3` | `lib/schemas/account.ts` |
| leads | `LEAD_STATUS` | `lib/constants.ts:27` | -- (needs creation) |
| deals | `DEAL_STAGE` | `lib/constants.ts:22` | `lib/schemas/deal.ts` |
| tasks | `TASK_STATUS` | `lib/constants.ts:38` | `lib/schemas/task.ts` |
| payments | `PAYMENT_STATUS` | `lib/constants.ts:30` | `lib/schemas/payment.ts` |
| services | `SERVICE_STATUS` | `lib/constants.ts:18` | `lib/schemas/service.ts` |
| tax_returns | `TAX_RETURN_STATUS` | `lib/constants.ts:53` | -- (needs creation) |
| conversations | `CONVERSATION_STATUS` | `lib/constants.ts:63` | -- (needs creation) |
| offers | `OFFER_STATUS` | `lib/constants.ts:67` | -- (needs creation) |
| service_deliveries | **needs update** | `lib/constants.ts:18` | -- (needs creation) |
| contacts | **needs creation** | -- | -- (needs creation) |
| pending_activations | **needs creation** | -- | -- (needs creation) |
| client_invoices | **needs creation** | -- | -- (needs creation) |
| dev_tasks | **needs creation** | -- | -- (needs creation) |
| form submissions | **needs creation** | -- | -- (needs creation) |
| lease_agreements | **needs creation** | -- | -- (needs creation) |
| signature_requests | **needs creation** | -- | -- (needs creation) |

---

## Enforcement

1. **CHECK constraints** on all status columns prevent the DB from accepting invalid values.
2. **Zod schemas** prevent the application layer from passing invalid values.
3. **constants.ts imports** prevent developers from typo-ing values.
4. **Audit health check** runs periodically to catch any data that slipped through.

All four layers are required. Any single layer alone is insufficient.
