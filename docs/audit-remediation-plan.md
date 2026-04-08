# Audit Remediation Plan -- td-operations

**Date**: 2026-04-08
**Source**: Full database audit of td-operations Supabase instance
**Deployment**: Each batch is independently deployable. Deploy in order. Verify before moving to next batch.

---

## BATCH 0: EMERGENCY -- RLS Security

**Priority**: CRITICAL -- deploy immediately
**Risk**: Active security vulnerabilities allowing unauthenticated data access

### Finding 0A: 11 "service_role" policies on {public} role with qual=true

These policies were intended for `service_role` but are assigned to `{public}`, meaning ANY unauthenticated request bypasses RLS.

**Affected tables**: `billing_entities`, `internal_messages`, `internal_threads`, `lease_agreements`, `signature_requests`, `client_partners`, `form_8832_applications`, `dev_tasks`, `job_queue`, `pipeline_stages`, `webhook_events`

**Fix SQL**:
```sql
-- For each affected table, drop the broken policy and recreate with correct role
-- Example pattern (repeat for each table):

-- billing_entities
DROP POLICY IF EXISTS "service_role_all_billing_entities" ON billing_entities;
CREATE POLICY "service_role_all_billing_entities" ON billing_entities
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- internal_messages
DROP POLICY IF EXISTS "service_role_all_internal_messages" ON internal_messages;
CREATE POLICY "service_role_all_internal_messages" ON internal_messages
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- internal_threads
DROP POLICY IF EXISTS "service_role_all_internal_threads" ON internal_threads;
CREATE POLICY "service_role_all_internal_threads" ON internal_threads
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- lease_agreements (has both a broken public policy AND a legitimate anon policy)
DROP POLICY IF EXISTS "service_role_all_lease_agreements" ON lease_agreements;
CREATE POLICY "service_role_all_lease_agreements" ON lease_agreements
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- signature_requests
DROP POLICY IF EXISTS "service_role_all_signature_requests" ON signature_requests;
CREATE POLICY "service_role_all_signature_requests" ON signature_requests
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- client_partners
DROP POLICY IF EXISTS "service_role_all_client_partners" ON client_partners;
CREATE POLICY "service_role_all_client_partners" ON client_partners
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- form_8832_applications
DROP POLICY IF EXISTS "service_role_all_form_8832_applications" ON form_8832_applications;
CREATE POLICY "service_role_all_form_8832_applications" ON form_8832_applications
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- dev_tasks
DROP POLICY IF EXISTS "service_role_all_dev_tasks" ON dev_tasks;
CREATE POLICY "service_role_all_dev_tasks" ON dev_tasks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- job_queue
DROP POLICY IF EXISTS "service_role_all_job_queue" ON job_queue;
CREATE POLICY "service_role_all_job_queue" ON job_queue
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- pipeline_stages
DROP POLICY IF EXISTS "service_role_all_pipeline_stages" ON pipeline_stages;
CREATE POLICY "service_role_all_pipeline_stages" ON pipeline_stages
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- webhook_events
DROP POLICY IF EXISTS "service_role_all_webhook_events" ON webhook_events;
CREATE POLICY "service_role_all_webhook_events" ON webhook_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

**Verification**:
```sql
-- Confirm no policies remain with role={public} and qual=true on these tables
SELECT schemaname, tablename, policyname, roles, qual
FROM pg_policies
WHERE roles = '{public}' AND qual = 'true'
  AND tablename IN (
    'billing_entities','internal_messages','internal_threads',
    'lease_agreements','signature_requests','client_partners',
    'form_8832_applications','dev_tasks','job_queue',
    'pipeline_stages','webhook_events'
  );
-- Expected: 0 rows
```

**Rollback**: If the app breaks (e.g., anon access was intentional for some reason), recreate the old policy:
```sql
DROP POLICY "service_role_all_<table>" ON <table>;
CREATE POLICY "service_role_all_<table>" ON <table>
  FOR ALL TO public USING (true) WITH CHECK (true);
```

---

### Finding 0B: 14 tables with public/anon SELECT+UPDATE qual=true

Form submission tables allow any anonymous user to read AND update any record.

**Affected tables**: `banking_submissions`, `contracts`, `formation_submissions`, `onboarding_submissions`, `oa_agreements`, `lease_agreements`, `offers`, `tax_quote_submissions`, `tax_return_submissions`, `closure_submissions`, `itin_submissions`, `ss4_applications`, `email_tracking`, `form_8832_applications`

**Fix strategy**: Restrict anon access to token-based filtering. Forms use a token URL parameter -- the policy should only allow access when the request includes a matching token.

**Fix SQL** (pattern for each token-based table):
```sql
-- offers (token column exists)
DROP POLICY IF EXISTS "anon_select_offers" ON offers;
CREATE POLICY "anon_select_offers" ON offers
  FOR SELECT TO anon
  USING (token = current_setting('request.headers', true)::json->>'x-offer-token');

DROP POLICY IF EXISTS "anon_update_offers" ON offers;
CREATE POLICY "anon_update_offers" ON offers
  FOR UPDATE TO anon
  USING (token = current_setting('request.headers', true)::json->>'x-offer-token')
  WITH CHECK (token = current_setting('request.headers', true)::json->>'x-offer-token');

-- For form tables without a token column, restrict to service_role only:
-- banking_submissions
DROP POLICY IF EXISTS "anon_all_banking_submissions" ON banking_submissions;
CREATE POLICY "service_role_all_banking_submissions" ON banking_submissions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Repeat pattern for: formation_submissions, onboarding_submissions,
-- tax_quote_submissions, tax_return_submissions, closure_submissions,
-- itin_submissions, ss4_applications, form_8832_applications
```

**Code change required**: Form pages that submit via anonymous Supabase client will need to switch to API routes that use the service_role client. This is a larger change -- for Batch 0, the interim fix is to verify that all form submissions go through API routes (which use `supabaseAdmin` / service_role), not direct client-side Supabase calls.

**Verification**:
```sql
SELECT schemaname, tablename, policyname, roles, cmd, qual
FROM pg_policies
WHERE roles IN ('{anon}', '{public}')
  AND qual = 'true'
  AND tablename IN (
    'banking_submissions','contracts','formation_submissions',
    'onboarding_submissions','oa_agreements','lease_agreements',
    'offers','tax_quote_submissions','tax_return_submissions',
    'closure_submissions','itin_submissions','ss4_applications',
    'email_tracking','form_8832_applications'
  );
-- Expected: 0 rows
```

---

### Finding 0C: 4 tables with zero RLS on sensitive data

**Affected tables**: `client_bank_accounts`, `bank_transactions`, `plaid_connections`, `oauth_tokens`

**Fix SQL**:
```sql
-- Enable RLS
ALTER TABLE client_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE plaid_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;

-- Add service_role-only access
CREATE POLICY "service_role_all" ON client_bank_accounts
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON bank_transactions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON plaid_connections
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON oauth_tokens
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

**Verification**:
```sql
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('client_bank_accounts','bank_transactions','plaid_connections','oauth_tokens');
-- Expected: all show rowsecurity = true
```

---

### Finding 0D: Authenticated clients can UPDATE any service_delivery, deals, tasks, tax_returns

The `authenticated` role has UPDATE policies with `qual = true` on tables that should be scoped.

**Fix SQL**:
```sql
-- service_deliveries: clients should only see their own
DROP POLICY IF EXISTS "authenticated_update_service_deliveries" ON service_deliveries;
CREATE POLICY "authenticated_update_service_deliveries" ON service_deliveries
  FOR UPDATE TO authenticated
  USING (account_id IN (SELECT get_client_account_ids(auth.uid())))
  WITH CHECK (account_id IN (SELECT get_client_account_ids(auth.uid())));

-- tasks: clients should only see tasks for their accounts
DROP POLICY IF EXISTS "authenticated_update_tasks" ON tasks;
CREATE POLICY "authenticated_update_tasks" ON tasks
  FOR UPDATE TO authenticated
  USING (account_id IN (SELECT get_client_account_ids(auth.uid())))
  WITH CHECK (account_id IN (SELECT get_client_account_ids(auth.uid())));
```

**Note**: Verify `get_client_account_ids()` function exists. If not, create it:
```sql
CREATE OR REPLACE FUNCTION get_client_account_ids(user_id uuid)
RETURNS SETOF uuid AS $$
  SELECT ac.account_id
  FROM account_contacts ac
  JOIN contacts c ON c.id = ac.contact_id
  WHERE c.auth_user_id = user_id;
$$ LANGUAGE sql SECURITY DEFINER STABLE;
```

---

### Finding 0E: No auth on offer-signed webhook

**File**: `app/api/webhooks/offer-signed/route.ts:15`

The POST handler has zero authentication. Anyone can POST to `/api/webhooks/offer-signed` with a valid `offer_token` and trigger the entire activation flow.

**Code fix** -- add at `app/api/webhooks/offer-signed/route.ts:17` (after `const body = await req.json()`):
```typescript
// File: app/api/webhooks/offer-signed/route.ts
// Add AFTER line 17: const body = await req.json()

// Verify request origin -- must come from our own contract page
const origin = req.headers.get("origin") || req.headers.get("referer") || ""
const apiSecret = req.headers.get("authorization")
const cronSecret = process.env.CRON_SECRET || process.env.API_SECRET_TOKEN
if (!origin.includes("tonydurante.us") && apiSecret !== `Bearer ${cronSecret}`) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}
```

**Verification**: Test that the contract signing flow still works end-to-end after adding auth.

**Rollback**: Remove the auth check lines.

---

## BATCH 1: P0 Data Fixes

**Priority**: HIGH -- deploy after Batch 0 is verified
**Risk**: Stuck records, invisible tasks, wrong financial data

### Finding 1A: Whop webhook writes "todo" instead of "To Do"

**File**: `app/api/webhooks/whop/route.ts`
**Lines**: 377, 389

```typescript
// Line 377 -- BEFORE:
status: "todo",
// Line 377 -- AFTER:
status: "To Do",

// Line 389 -- BEFORE:
status: "todo",
// Line 389 -- AFTER:
status: "To Do",
```

**Data fix** -- run AFTER deploying the code fix:
```sql
UPDATE tasks SET status = 'To Do' WHERE status = 'todo';
-- Returns: number of rows updated
```

**Verification**:
```sql
SELECT count(*) FROM tasks WHERE status = 'todo';
-- Expected: 0
```

---

### Finding 1B: 57 payments marked "Paid" with NULL paid_date

```sql
UPDATE payments
SET paid_date = COALESCE(
  (updated_at::date)::text,
  (created_at::date)::text
)
WHERE status = 'Paid' AND paid_date IS NULL;
```

**Verification**:
```sql
SELECT count(*) FROM payments WHERE status = 'Paid' AND paid_date IS NULL;
-- Expected: 0
```

---

### Finding 1C: 12 stuck pending_activations at payment_confirmed

These records had their payment confirmed but the activate-service workflow never ran or failed silently.

**Manual remediation** -- for each stuck record, either trigger the activation or create a task:
```sql
-- First, identify the stuck records
SELECT pa.id, pa.client_name, pa.client_email, pa.offer_token,
       pa.payment_confirmed_at, pa.status, pa.amount
FROM pending_activations pa
WHERE pa.status = 'payment_confirmed'
ORDER BY pa.payment_confirmed_at ASC;

-- Option A: Re-trigger activation for each (via API call)
-- For each row, call POST /api/workflows/activate-service
-- with body: { "pending_activation_id": "<id>" }

-- Option B: Create manual tasks for Antonio
INSERT INTO tasks (task_title, description, assigned_to, priority, category, status)
SELECT
  'Stuck activation: ' || pa.client_name || ' (payment confirmed ' || pa.payment_confirmed_at::date || ')',
  'pending_activation ' || pa.id || ' has been at payment_confirmed since ' || pa.payment_confirmed_at || '. Offer: ' || pa.offer_token || '. Amount: $' || pa.amount || '. Manually trigger activation or investigate why it failed.',
  'Antonio',
  'Urgent',
  'Internal',
  'To Do'
FROM pending_activations pa
WHERE pa.status = 'payment_confirmed';
```

**Verification**:
```sql
SELECT count(*) FROM pending_activations WHERE status = 'payment_confirmed';
-- Expected: 0 (all should be 'activated' or have follow-up tasks)
```

---

### Finding 1D: overdue-payments-report uses wrong case

**File**: `app/api/cron/overdue-payments-report/route.ts:33`

```typescript
// Line 33 -- BEFORE:
.eq("status", "overdue")
// Line 33 -- AFTER:
.eq("status", "Overdue")
```

**Verification**: After deploying, trigger the cron manually and confirm it finds overdue payments (if any exist).

---

## BATCH 2: Status Normalization

**Priority**: HIGH -- deploy after Batch 1
**Risk**: Must normalize data BEFORE adding CHECK constraints, or the ALTER TABLE will fail

### Step 2A: Normalize existing data

```sql
-- service_deliveries: normalize Title Case to lowercase
UPDATE service_deliveries SET status = 'cancelled' WHERE status = 'Cancelled';
UPDATE service_deliveries SET status = 'completed' WHERE status = 'Completed';
UPDATE service_deliveries SET status = 'active' WHERE status IN ('Not Started', 'In Progress');

-- Verify no unexpected values remain
SELECT status, count(*) FROM service_deliveries GROUP BY status ORDER BY count DESC;
-- Expected: only 'active', 'blocked', 'completed', 'cancelled'
```

### Step 2B: Update lib/constants.ts

**File**: `lib/constants.ts`

Add ALL missing status constants. The full updated file should include:

```typescript
// Add after existing constants (line 68):

export const SERVICE_DELIVERY_STATUS = [
  'active', 'blocked', 'completed', 'cancelled',
] as const

export const CONTACT_STATUS = [
  'active', 'inactive',
] as const

export const INVOICE_STATUS = [
  'Draft', 'Sent', 'Overdue', 'Partial', 'Paid', 'Void',
] as const

export const PENDING_ACTIVATION_STATUS = [
  'awaiting_payment', 'payment_confirmed', 'activating', 'activated', 'failed',
] as const

export const DEV_TASK_STATUS = [
  'todo', 'in_progress', 'done', 'blocked',
] as const

export const FORM_SUBMISSION_STATUS = [
  'draft', 'submitted', 'in_review', 'approved', 'rejected',
] as const

export const LEASE_STATUS = [
  'draft', 'sent', 'signed', 'active', 'expired', 'terminated',
] as const

export const SIGNATURE_REQUEST_STATUS = [
  'pending', 'signed', 'expired', 'cancelled',
] as const

export const JOB_QUEUE_STATUS = [
  'pending', 'running', 'completed', 'failed',
] as const

// Types
export type ServiceDeliveryStatus = (typeof SERVICE_DELIVERY_STATUS)[number]
export type ContactStatus = (typeof CONTACT_STATUS)[number]
export type InvoiceStatus = (typeof INVOICE_STATUS)[number]
export type PendingActivationStatus = (typeof PENDING_ACTIVATION_STATUS)[number]
export type DevTaskStatus = (typeof DEV_TASK_STATUS)[number]
export type FormSubmissionStatus = (typeof FORM_SUBMISSION_STATUS)[number]
export type LeaseStatus = (typeof LEASE_STATUS)[number]
export type SignatureRequestStatus = (typeof SIGNATURE_REQUEST_STATUS)[number]
export type JobQueueStatus = (typeof JOB_QUEUE_STATUS)[number]
```

Also update `OFFER_STATUS` to match production (lowercase):
```typescript
// Replace existing OFFER_STATUS (line 67-69):
export const OFFER_STATUS = [
  'draft', 'sent', 'viewed', 'accepted', 'signed', 'completed', 'rejected', 'expired', 'negotiating',
] as const
```

### Step 2C: Add CHECK constraints

Run AFTER data normalization (Step 2A) and code deployment (Step 2B):

```sql
-- accounts
ALTER TABLE accounts
  ADD CONSTRAINT accounts_status_check
  CHECK (status IN ('Active', 'Pending Formation', 'Delinquent', 'Suspended', 'Cancelled', 'Closed'));

-- leads
ALTER TABLE leads
  ADD CONSTRAINT leads_status_check
  CHECK (status IN ('New', 'Call Scheduled', 'Call Done', 'Offer Sent', 'Negotiating', 'Converted', 'Lost', 'Suspended'));

-- tasks
ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('To Do', 'In Progress', 'Waiting', 'Done', 'Cancelled'));

-- payments.status
ALTER TABLE payments
  ADD CONSTRAINT payments_status_check
  CHECK (status IN ('Pending', 'Paid', 'Overdue', 'Delinquent', 'Waived', 'Refunded'));

-- payments.invoice_status
ALTER TABLE payments
  ADD CONSTRAINT payments_invoice_status_check
  CHECK (invoice_status IS NULL OR invoice_status IN ('Draft', 'Sent', 'Overdue', 'Partial', 'Paid', 'Void'));

-- service_deliveries
ALTER TABLE service_deliveries
  ADD CONSTRAINT service_deliveries_status_check
  CHECK (status IN ('active', 'blocked', 'completed', 'cancelled'));

-- offers
ALTER TABLE offers
  ADD CONSTRAINT offers_status_check
  CHECK (status IN ('draft', 'sent', 'viewed', 'accepted', 'signed', 'completed', 'rejected', 'expired', 'negotiating'));

-- tax_returns
ALTER TABLE tax_returns
  ADD CONSTRAINT tax_returns_status_check
  CHECK (status IN ('Payment Pending', 'Link Sent - Awaiting Data', 'Data Received', 'Sent to India', 'Extension Filed', 'TR Completed - Awaiting Signature', 'TR Filed'));

-- pending_activations
ALTER TABLE pending_activations
  ADD CONSTRAINT pending_activations_status_check
  CHECK (status IN ('awaiting_payment', 'payment_confirmed', 'activating', 'activated', 'failed'));

-- deals (stage column, not status)
ALTER TABLE deals
  ADD CONSTRAINT deals_stage_check
  CHECK (stage IN ('Initial Consultation', 'Offer Sent', 'Negotiation', 'Agreement Signed', 'Paid', 'Closed Won', 'Closed Lost'));

-- conversations
ALTER TABLE conversations
  ADD CONSTRAINT conversations_status_check
  CHECK (status IS NULL OR status IN ('New', 'Proposed', 'Approved', 'Sent', 'Archived'));

-- client_invoices
ALTER TABLE client_invoices
  ADD CONSTRAINT client_invoices_status_check
  CHECK (status IN ('Draft', 'Sent', 'Overdue', 'Partial', 'Paid', 'Void'));

-- contacts
ALTER TABLE contacts
  ADD CONSTRAINT contacts_status_check
  CHECK (status IS NULL OR status IN ('active', 'inactive'));

-- dev_tasks
ALTER TABLE dev_tasks
  ADD CONSTRAINT dev_tasks_status_check
  CHECK (status IN ('todo', 'in_progress', 'done', 'blocked'));

-- job_queue
ALTER TABLE job_queue
  ADD CONSTRAINT job_queue_status_check
  CHECK (status IN ('pending', 'running', 'completed', 'failed'));

-- lease_agreements
ALTER TABLE lease_agreements
  ADD CONSTRAINT lease_agreements_status_check
  CHECK (status IN ('draft', 'sent', 'signed', 'active', 'expired', 'terminated'));

-- signature_requests
ALTER TABLE signature_requests
  ADD CONSTRAINT signature_requests_status_check
  CHECK (status IN ('pending', 'signed', 'expired', 'cancelled'));
```

**Verification** -- confirm no existing data violates the constraints before running (run these SELECT queries BEFORE the ALTER TABLE):
```sql
-- Check for violations on each table
SELECT status, count(*) FROM accounts GROUP BY status ORDER BY count DESC;
SELECT status, count(*) FROM leads GROUP BY status ORDER BY count DESC;
SELECT status, count(*) FROM tasks GROUP BY status ORDER BY count DESC;
SELECT status, count(*) FROM payments GROUP BY status ORDER BY count DESC;
SELECT status, count(*) FROM service_deliveries GROUP BY status ORDER BY count DESC;
SELECT status, count(*) FROM offers GROUP BY status ORDER BY count DESC;
SELECT status, count(*) FROM tax_returns GROUP BY status ORDER BY count DESC;
SELECT status, count(*) FROM pending_activations GROUP BY status ORDER BY count DESC;
SELECT stage, count(*) FROM deals GROUP BY stage ORDER BY count DESC;
-- Any values NOT in the allowed list = must be normalized first
```

**Rollback**:
```sql
ALTER TABLE <table> DROP CONSTRAINT <table>_status_check;
```

### Step 2D: Add status validation to crm_update_record

**File**: `lib/mcp/tools/crm.ts:761`

Add validation before the Supabase update call:

```typescript
// Add at line 761, before the supabaseAdmin.from(table).update() call:

// Validate status if present
if (updates.status) {
  const STATUS_MAP: Record<string, readonly string[]> = {
    accounts: ACCOUNT_STATUS,
    leads: LEAD_STATUS,
    tasks: TASK_STATUS,
    payments: PAYMENT_STATUS,
    service_deliveries: SERVICE_DELIVERY_STATUS,
    tax_returns: TAX_RETURN_STATUS,
    conversations: CONVERSATION_STATUS,
    contacts: CONTACT_STATUS,
  }
  const allowed = STATUS_MAP[table]
  if (allowed && !allowed.includes(updates.status)) {
    return {
      content: [{
        type: "text" as const,
        text: `Invalid status "${updates.status}" for ${table}. Allowed: ${allowed.join(", ")}`,
      }],
    }
  }
}
// Validate stage for deals
if (table === "deals" && updates.stage) {
  if (!DEAL_STAGE.includes(updates.stage)) {
    return {
      content: [{
        type: "text" as const,
        text: `Invalid stage "${updates.stage}" for deals. Allowed: ${DEAL_STAGE.join(", ")}`,
      }],
    }
  }
}
```

Also add the imports at the top of the registerCrmTools function:
```typescript
import {
  ACCOUNT_STATUS, LEAD_STATUS, TASK_STATUS, PAYMENT_STATUS,
  SERVICE_DELIVERY_STATUS, TAX_RETURN_STATUS, CONVERSATION_STATUS,
  CONTACT_STATUS, DEAL_STAGE
} from "@/lib/constants"
```

---

## BATCH 3: Pipeline & Stage Fixes

**Priority**: MEDIUM
**Risk**: Low -- data cleanup, no schema changes

### Finding 3A: "Annual Renewal" SDs with no matching pipeline

Service deliveries with `pipeline = 'Annual Renewal'` exist but `pipeline_stages` only has stages for `'Billing Annual Renewal'` or `'State Annual Report'`.

**Fix SQL**:
```sql
-- Option A: Rename to match existing pipeline
UPDATE service_deliveries
SET pipeline = 'Billing Annual Renewal'
WHERE pipeline = 'Annual Renewal';

-- OR Option B: Create pipeline stages for "Annual Renewal"
-- (Only if "Annual Renewal" is intentionally distinct from "Billing Annual Renewal")
```

**Verification**:
```sql
SELECT DISTINCT sd.pipeline
FROM service_deliveries sd
WHERE sd.pipeline NOT IN (SELECT DISTINCT service_type FROM pipeline_stages)
  AND sd.pipeline IS NOT NULL;
-- Expected: 0 rows
```

### Finding 3B: Tax Return SD with phantom stage "1st Installment Paid"

```sql
-- Find the record
SELECT id, service_name, stage, pipeline
FROM service_deliveries
WHERE stage = '1st Installment Paid';

-- Fix: set to the correct pipeline stage
UPDATE service_deliveries
SET stage = 'Data Collection',  -- or whatever the correct current stage is
    stage_order = 2             -- match the pipeline_stages.stage_order
WHERE stage = '1st Installment Paid';
```

### Finding 3C: 3 SDs with wrong stage_order values

```sql
-- Find mismatched stage_orders
SELECT sd.id, sd.service_name, sd.pipeline, sd.stage, sd.stage_order,
       ps.stage_order AS correct_order
FROM service_deliveries sd
JOIN pipeline_stages ps ON ps.service_type = sd.pipeline AND ps.stage_name = sd.stage
WHERE sd.stage_order != ps.stage_order;

-- Fix: sync stage_order from pipeline_stages
UPDATE service_deliveries sd
SET stage_order = ps.stage_order
FROM pipeline_stages ps
WHERE ps.service_type = sd.pipeline
  AND ps.stage_name = sd.stage
  AND sd.stage_order != ps.stage_order;
```

### Finding 3D: 875 SDs with NULL stage

```sql
-- For completed SDs: set to terminal stage of their pipeline
UPDATE service_deliveries sd
SET stage = ps.stage_name,
    stage_order = ps.stage_order
FROM (
  SELECT DISTINCT ON (service_type) service_type, stage_name, stage_order
  FROM pipeline_stages
  ORDER BY service_type, stage_order DESC
) ps
WHERE sd.pipeline = ps.service_type
  AND sd.status = 'completed'
  AND sd.stage IS NULL;

-- For active SDs: set to first stage of their pipeline
UPDATE service_deliveries sd
SET stage = ps.stage_name,
    stage_order = ps.stage_order
FROM (
  SELECT DISTINCT ON (service_type) service_type, stage_name, stage_order
  FROM pipeline_stages
  ORDER BY service_type, stage_order ASC
) ps
WHERE sd.pipeline = ps.service_type
  AND sd.status = 'active'
  AND sd.stage IS NULL;
```

**Verification**:
```sql
SELECT count(*) FROM service_deliveries WHERE stage IS NULL AND pipeline IS NOT NULL;
-- Expected: 0 (or close to 0 -- some may not have matching pipeline_stages)
```

---

## BATCH 4: Portal Tier Sync

**Priority**: MEDIUM
**Risk**: Low -- data consistency fix

### Finding 4A: portal_tier mismatches between contacts, accounts, auth.users

3 active contacts have conflicting portal_tier values across their account and auth.users records.

**Fix SQL**:
```sql
-- First, audit the conflicts
SELECT c.full_name, c.portal_tier AS contact_tier,
       a.portal_tier AS account_tier,
       u.raw_user_meta_data->>'portal_tier' AS auth_tier
FROM contacts c
JOIN account_contacts ac ON ac.contact_id = c.id
JOIN accounts a ON a.id = ac.account_id
LEFT JOIN auth.users u ON u.id = c.auth_user_id
WHERE c.portal_tier IS DISTINCT FROM a.portal_tier
   OR c.portal_tier IS DISTINCT FROM (u.raw_user_meta_data->>'portal_tier');
```

### Finding 4B: "full" tier should be "active"

```sql
UPDATE accounts SET portal_tier = 'active' WHERE portal_tier = 'full';
UPDATE contacts SET portal_tier = 'active' WHERE portal_tier = 'full';
```

### Finding 4C: 61 auth users with NULL portal_tier

```sql
-- Sync from contacts
UPDATE auth.users u
SET raw_user_meta_data = jsonb_set(
  COALESCE(u.raw_user_meta_data, '{}'::jsonb),
  '{portal_tier}',
  to_jsonb(c.portal_tier)
)
FROM contacts c
WHERE c.auth_user_id = u.id
  AND c.portal_tier IS NOT NULL
  AND (u.raw_user_meta_data->>'portal_tier') IS NULL;
```

### Finding 4D: Create DB trigger for future sync

```sql
CREATE OR REPLACE FUNCTION sync_portal_tier()
RETURNS trigger AS $$
BEGIN
  -- When contact portal_tier changes, sync to account and auth.users
  IF TG_TABLE_NAME = 'contacts' AND NEW.portal_tier IS DISTINCT FROM OLD.portal_tier THEN
    -- Sync to accounts
    UPDATE accounts a
    SET portal_tier = NEW.portal_tier
    FROM account_contacts ac
    WHERE ac.contact_id = NEW.id AND ac.account_id = a.id;

    -- Sync to auth.users
    IF NEW.auth_user_id IS NOT NULL THEN
      UPDATE auth.users
      SET raw_user_meta_data = jsonb_set(
        COALESCE(raw_user_meta_data, '{}'::jsonb),
        '{portal_tier}',
        to_jsonb(NEW.portal_tier)
      )
      WHERE id = NEW.auth_user_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER sync_portal_tier_on_contact
  AFTER UPDATE OF portal_tier ON contacts
  FOR EACH ROW
  EXECUTE FUNCTION sync_portal_tier();
```

**Verification**:
```sql
-- No more mismatches
SELECT count(*)
FROM contacts c
JOIN account_contacts ac ON ac.contact_id = c.id
JOIN accounts a ON a.id = ac.account_id
WHERE c.portal_tier IS DISTINCT FROM a.portal_tier;
-- Expected: 0
```

---

## BATCH 5: Cron Job Hardening

**Priority**: MEDIUM
**Risk**: Low -- observability improvements

### Finding 5A: 10 crons missing cron_log writes

Add cron_log INSERT to the success and error paths of each cron.

**Crons needing fixes**:

| Cron | File |
|------|------|
| overdue-payments-report | `app/api/cron/overdue-payments-report/route.ts` |
| email-monitor | `app/api/cron/email-monitor/route.ts` |
| deadline-reminders | `app/api/cron/deadline-reminders/route.ts` |
| wizard-reminders | `app/api/cron/wizard-reminders/route.ts` |
| portal-issues | `app/api/cron/portal-issues/route.ts` |
| annual-installments | `app/api/cron/annual-installments/route.ts` |
| invoice-overdue | `app/api/cron/invoice-overdue/route.ts` |
| portal-recurring-invoices | `app/api/cron/portal-recurring-invoices/route.ts` |
| portal-digest | `app/api/cron/portal-digest/route.ts` |
| mercury-sync | `app/api/cron/mercury-sync/route.ts` |

**Code pattern** to add to each cron's success path (before the final `return`):
```typescript
await supabase.from("cron_log").insert({
  endpoint: "/api/cron/<cron-name>",
  status: "success",
  details: { /* relevant counts/results */ },
  executed_at: new Date().toISOString(),
})
```

And to each cron's catch block:
```typescript
await supabase.from("cron_log").insert({
  endpoint: "/api/cron/<cron-name>",
  status: "error",
  error_message: err instanceof Error ? err.message : String(err),
  executed_at: new Date().toISOString(),
}).catch(() => {}) // never let logging fail the cron
```

### Finding 5B: portal-recurring-invoices missing from vercel.json

**File**: `vercel.json`

Add after line 57 (after the `invoice-overdue` entry):
```json
{
  "path": "/api/cron/portal-recurring-invoices",
  "schedule": "0 9 1 * *"
}
```

### Finding 5C: Brain webhook WHEN clauses

The 5 Supabase database webhooks for the "brain" (event processing) fire on every INSERT/UPDATE without WHEN filters, generating unnecessary load.

**Fix**: Add WHEN clauses to each webhook trigger in Supabase Dashboard > Database > Webhooks. Example:
```sql
-- For tasks webhook: only fire when status changes
ALTER TRIGGER brain_tasks ON tasks
  -- Add WHEN clause
  WHEN (OLD.status IS DISTINCT FROM NEW.status);
```

### Finding 5D: Consolidate 4 duplicate updated_at trigger functions

```sql
-- Find all updated_at functions
SELECT routine_name, routine_definition
FROM information_schema.routines
WHERE routine_name LIKE '%updated_at%'
  AND routine_schema = 'public';

-- Consolidate into one:
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop duplicates (after verifying they are identical):
-- DROP FUNCTION IF EXISTS set_updated_at();
-- DROP FUNCTION IF EXISTS trigger_set_updated_at();
-- etc.
```

### Finding 5E: 43 tables missing updated_at triggers

```sql
-- Find tables with updated_at column but no trigger
SELECT c.table_name
FROM information_schema.columns c
WHERE c.column_name = 'updated_at'
  AND c.table_schema = 'public'
  AND c.table_name NOT IN (
    SELECT event_object_table
    FROM information_schema.triggers
    WHERE trigger_schema = 'public'
      AND action_statement LIKE '%updated_at%'
  )
ORDER BY c.table_name;

-- For each missing table:
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON <table_name>
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
```

**Verification**:
```sql
-- All tables with updated_at should have a trigger
SELECT c.table_name,
       EXISTS (
         SELECT 1 FROM information_schema.triggers t
         WHERE t.event_object_table = c.table_name
           AND t.action_statement LIKE '%updated_at%'
       ) AS has_trigger
FROM information_schema.columns c
WHERE c.column_name = 'updated_at'
  AND c.table_schema = 'public'
ORDER BY has_trigger, c.table_name;
-- Expected: all rows show has_trigger = true
```

---

## BATCH 6: Structural Prevention

**Priority**: STANDARD -- long-term hardening
**Risk**: Low -- code quality improvements

### Finding 6A: Create Zod schemas for all tables

**Tables needing schemas** (schemas already exist for: account, task, payment, service, deal, portal-invoice):

- `lib/schemas/lead.ts` -- validate `LEAD_STATUS`
- `lib/schemas/tax-return.ts` -- validate `TAX_RETURN_STATUS`
- `lib/schemas/service-delivery.ts` -- validate `SERVICE_DELIVERY_STATUS`
- `lib/schemas/offer.ts` -- validate `OFFER_STATUS`
- `lib/schemas/conversation.ts` -- validate `CONVERSATION_STATUS`
- `lib/schemas/pending-activation.ts` -- validate `PENDING_ACTIVATION_STATUS`
- `lib/schemas/lease.ts` -- validate `LEASE_STATUS`

**Pattern** for each:
```typescript
import { z } from "zod"
import { LEAD_STATUS } from "@/lib/constants"

export const createLeadSchema = z.object({
  full_name: z.string().min(1).max(200),
  email: z.string().email(),
  status: z.enum(LEAD_STATUS).default("New"),
  // ... other fields
})

export const updateLeadSchema = createLeadSchema.partial().extend({
  id: z.string().uuid(),
})
```

### Finding 6B: Drop ghost ENUM

```sql
-- Verify the ENUM is not referenced by any column
SELECT c.table_name, c.column_name, c.udt_name
FROM information_schema.columns c
WHERE c.udt_name = 'offer_status';
-- If 0 rows (no column uses it), safe to drop:

DROP TYPE IF EXISTS offer_status;
```

### Finding 6C: Add audit health check query

Create a reusable SQL query (stored as a system_doc or in `docs/`) that checks for:

```sql
-- Health check: invalid status values
WITH checks AS (
  SELECT 'accounts' AS tbl, status AS val FROM accounts WHERE status NOT IN ('Active','Pending Formation','Delinquent','Suspended','Cancelled','Closed')
  UNION ALL
  SELECT 'tasks', status FROM tasks WHERE status NOT IN ('To Do','In Progress','Waiting','Done','Cancelled')
  UNION ALL
  SELECT 'payments', status FROM payments WHERE status NOT IN ('Pending','Paid','Overdue','Delinquent','Waived','Refunded')
  UNION ALL
  SELECT 'service_deliveries', status FROM service_deliveries WHERE status NOT IN ('active','blocked','completed','cancelled')
  UNION ALL
  SELECT 'leads', status FROM leads WHERE status NOT IN ('New','Call Scheduled','Call Done','Offer Sent','Negotiating','Converted','Lost','Suspended')
  UNION ALL
  SELECT 'offers', status FROM offers WHERE status NOT IN ('draft','sent','viewed','accepted','signed','completed','rejected','expired','negotiating')
  UNION ALL
  SELECT 'pending_activations', status FROM pending_activations WHERE status NOT IN ('awaiting_payment','payment_confirmed','activating','activated','failed')
  UNION ALL
  SELECT 'deals_stage', stage FROM deals WHERE stage NOT IN ('Initial Consultation','Offer Sent','Negotiation','Agreement Signed','Paid','Closed Won','Closed Lost')
)
SELECT tbl, val, count(*) FROM checks GROUP BY tbl, val ORDER BY tbl;
-- Expected after remediation: 0 rows
```

---

## Deployment Checklist

| Batch | Depends On | Estimated Time | Rollback Complexity |
|-------|-----------|----------------|-------------------|
| 0 - RLS Security | None | 30 min | Low (DROP + recreate policies) |
| 1 - P0 Data Fixes | Batch 0 | 15 min | Low (status values can be reverted) |
| 2 - Status Normalization | Batch 1 | 1 hour | Medium (must drop constraints first) |
| 3 - Pipeline Fixes | Batch 1 | 30 min | Low (data-only changes) |
| 4 - Portal Tier Sync | None | 30 min | Low (trigger can be dropped) |
| 5 - Cron Hardening | None | 2 hours | Low (additive code changes) |
| 6 - Structural Prevention | Batch 2 | 3 hours | Low (schema files are additive) |

---

## Post-Deployment Verification

After ALL batches are deployed, run the full health check:

```sql
-- 1. No invalid status values
-- (Run the health check query from Finding 6C)

-- 2. No CHECK constraint violations possible
SELECT conname, conrelid::regclass
FROM pg_constraint
WHERE contype = 'c' AND conname LIKE '%status_check%'
ORDER BY conrelid::regclass;
-- Expected: one row per table from Step 2C

-- 3. No public/anon policies with qual=true on sensitive tables
SELECT tablename, policyname, roles, qual
FROM pg_policies
WHERE roles IN ('{public}', '{anon}')
  AND qual = 'true'
ORDER BY tablename;
-- Expected: 0 rows (or only intentionally public tables like static content)

-- 4. RLS enabled on all tables with client data
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('client_bank_accounts','bank_transactions','plaid_connections','oauth_tokens')
ORDER BY tablename;
-- Expected: all rowsecurity = true

-- 5. No "todo" tasks
SELECT count(*) FROM tasks WHERE status = 'todo';
-- Expected: 0

-- 6. No NULL paid_date on Paid payments
SELECT count(*) FROM payments WHERE status = 'Paid' AND paid_date IS NULL;
-- Expected: 0

-- 7. All crons in vercel.json
-- Manual check: compare `ls app/api/cron/` with vercel.json crons array
```
