-- =============================================================================
-- NORMALIZE & CONSTRAIN — Tony Durante LLC Supabase Database
-- =============================================================================
-- Deployment order:
--   STEP 1: Normalize existing dirty data (UPDATE statements)
--   STEP 2: Add/replace CHECK constraints on TEXT/VARCHAR status columns
--   STEP 3: Rollback statements (DROP CONSTRAINT)
--
-- IMPORTANT: Run STEP 1 before STEP 2. Constraints will fail if dirty data
-- still exists.
--
-- Tables with ENUM columns (tasks, payments, accounts, leads) do NOT need
-- CHECK constraints — Postgres enforces ENUM values at insert time.
--
-- Generated: 2026-04-08
-- =============================================================================


-- #############################################################################
-- STEP 1: NORMALIZE EXISTING DATA
-- #############################################################################
-- Run these UPDATEs first to clean up known dirty values before adding
-- constraints. Each UPDATE is idempotent (safe to re-run).

BEGIN;

-- -------------------------------------------------------------------------
-- 1a. service_deliveries.status — normalize case variants
-- -------------------------------------------------------------------------
-- 'Cancelled' (32 rows) → 'cancelled'
UPDATE service_deliveries SET status = 'cancelled', updated_at = NOW()
  WHERE status = 'Cancelled';

-- 'Completed' (10 rows) → 'completed'
UPDATE service_deliveries SET status = 'completed', updated_at = NOW()
  WHERE status = 'Completed';

-- 'Not Started' (5 rows) → 'active' (canonical value for anything not yet finished)
UPDATE service_deliveries SET status = 'active', updated_at = NOW()
  WHERE status = 'Not Started';

-- 'In Progress' (4 rows) → 'active'
UPDATE service_deliveries SET status = 'active', updated_at = NOW()
  WHERE status = 'In Progress';

-- -------------------------------------------------------------------------
-- 1b. service_deliveries.service_type — normalize to pipeline_stages values
-- -------------------------------------------------------------------------
-- NOTE: pipeline_stages uses 'CMRA Mailing Address', 'EIN', 'Annual Renewal'
-- but the allowed list specifies 'CMRA', 'EIN Application', 'Billing Annual Renewal'.
-- We normalize TO the pipeline_stages values since those are what the pipeline
-- engine relies on. If you want to rename pipeline_stages too, do that first.
-- Currently these are ALREADY consistent — no normalization needed.

-- -------------------------------------------------------------------------
-- 1c. accounts.portal_tier — fix 'full' → 'active'
-- -------------------------------------------------------------------------
-- 'full' (3 rows) is not a valid portal tier
UPDATE accounts SET portal_tier = 'active', updated_at = NOW()
  WHERE portal_tier = 'full';

-- -------------------------------------------------------------------------
-- 1d. tasks.status — fix lowercase 'todo' from Whop webhook
-- -------------------------------------------------------------------------
-- NOTE: tasks.status is an ENUM (task_status). If 'todo' exists as an enum
-- label, this UPDATE converts it. If it does not exist as a label, no rows
-- will match (0 rows, safe no-op). Currently 0 rows have this value.
-- Keeping this as a defensive measure for future Whop webhook payloads.
-- UPDATE tasks SET status = 'To Do' WHERE status::text = 'todo';
-- ^ Commented out: would fail if 'todo' is not an enum label. Instead,
--   ensure the Whop webhook handler maps 'todo' → 'To Do' before insert.

COMMIT;


-- #############################################################################
-- STEP 2: ADD / REPLACE CHECK CONSTRAINTS
-- #############################################################################
-- For tables that ALREADY have a matching constraint, we DROP then re-ADD
-- to ensure the allowed values list is current. For tables without a
-- constraint, we simply ADD.
--
-- Each block is wrapped in its own transaction so a single failure does not
-- block the rest.

-- =========================================================================
-- 2.1  service_deliveries.status
-- =========================================================================
-- No existing constraint. Add new.
BEGIN;
ALTER TABLE service_deliveries
  ADD CONSTRAINT chk_sd_status
  CHECK (status IN ('active', 'blocked', 'completed', 'cancelled'));
COMMIT;

-- =========================================================================
-- 2.2  service_deliveries.service_type
-- =========================================================================
-- No existing constraint. Add new.
-- Allowed values = union of pipeline_stages values + known additional types.
BEGIN;
ALTER TABLE service_deliveries
  ADD CONSTRAINT chk_sd_service_type
  CHECK (service_type IN (
    'Company Formation', 'Client Onboarding', 'Tax Return', 'State RA Renewal',
    'CMRA Mailing Address', 'Shipping', 'Public Notary',
    'Banking Fintech', 'Banking Physical', 'ITIN', 'Company Closure',
    'Client Offboarding', 'State Annual Report', 'EIN', 'EIN Application',
    'Support', 'Billing Annual Renewal', 'Annual Renewal', 'CMRA'
  ));
COMMIT;

-- =========================================================================
-- 2.3  offers.status
-- =========================================================================
-- EXISTING: offers_status_check allows (draft, sent, viewed, accepted, signed, completed, expired)
-- This matches the actual DB constraint. Keep as-is (no change needed).
-- If you want to tighten it, uncomment the block below.
/*
BEGIN;
ALTER TABLE offers DROP CONSTRAINT IF EXISTS offers_status_check;
ALTER TABLE offers
  ADD CONSTRAINT chk_offers_status
  CHECK (status::text IN ('draft', 'sent', 'viewed', 'signed', 'completed', 'accepted', 'expired'));
COMMIT;
*/

-- =========================================================================
-- 2.4  lease_agreements.status
-- =========================================================================
-- No existing constraint. Add new.
BEGIN;
ALTER TABLE lease_agreements
  ADD CONSTRAINT chk_lease_status
  CHECK (status::text IN ('draft', 'sent', 'viewed', 'signed'));
COMMIT;

-- =========================================================================
-- 2.5  oa_agreements.status
-- =========================================================================
-- EXISTING: oa_agreements_status_check allows (draft, sent, viewed, partially_signed, signed)
-- Already correct. No change needed.

-- =========================================================================
-- 2.6  ss4_applications.status
-- =========================================================================
-- No existing constraint. Add new.
BEGIN;
ALTER TABLE ss4_applications
  ADD CONSTRAINT chk_ss4_status
  CHECK (status IN ('draft', 'awaiting_signature', 'signed', 'submitted', 'done', 'fax_failed'));
COMMIT;

-- =========================================================================
-- 2.7  deadlines.status
-- =========================================================================
-- No existing constraint. Add new.
BEGIN;
ALTER TABLE deadlines
  ADD CONSTRAINT chk_deadline_status
  CHECK (status IN ('Pending', 'Completed', 'Filed', 'Not Started', 'Overdue'));
COMMIT;

-- =========================================================================
-- 2.8  documents.status
-- =========================================================================
-- EXISTING: documents_status_check allows (pending, processed, classified, unclassified, error)
-- Already correct. No change needed.

-- =========================================================================
-- 2.9  client_invoices.status
-- =========================================================================
-- EXISTING: client_invoices_status_check allows (Draft, Sent, Paid, Overdue, Cancelled)
-- Missing 'Partial'. Replace to add it.
BEGIN;
ALTER TABLE client_invoices DROP CONSTRAINT IF EXISTS client_invoices_status_check;
ALTER TABLE client_invoices
  ADD CONSTRAINT chk_client_invoices_status
  CHECK (status IN ('Draft', 'Sent', 'Paid', 'Partial', 'Overdue', 'Cancelled'));
COMMIT;

-- =========================================================================
-- 2.10 client_expenses.status
-- =========================================================================
-- EXISTING: client_expenses_status_check allows (Pending, Paid, Overdue, Cancelled)
-- Already correct. No change needed.

-- =========================================================================
-- 2.11 banking_submissions.status
-- =========================================================================
-- EXISTING: banking_submissions_status_check allows (pending, sent, opened, completed, reviewed)
-- Already correct. No change needed.

-- =========================================================================
-- 2.12 formation_submissions.status
-- =========================================================================
-- EXISTING: formation_submissions_status_check allows (pending, sent, opened, completed, reviewed)
-- Already correct. No change needed.

-- =========================================================================
-- 2.13 onboarding_submissions.status
-- =========================================================================
-- EXISTING: onboarding_submissions_status_check allows (pending, sent, opened, completed, reviewed)
-- Already correct. No change needed.

-- =========================================================================
-- 2.14 tax_return_submissions.status
-- =========================================================================
-- EXISTING: tax_return_submissions_status_check allows (pending, sent, opened, completed, reviewed)
-- Already correct. No change needed.

-- =========================================================================
-- 2.15 itin_submissions.status
-- =========================================================================
-- EXISTING: itin_submissions_status_check allows (pending, sent, opened, completed, reviewed)
-- Already correct. No change needed.

-- =========================================================================
-- 2.16 closure_submissions.status
-- =========================================================================
-- EXISTING: closure_submissions_status_check allows (pending, sent, opened, completed, reviewed)
-- Already correct. No change needed.

-- =========================================================================
-- 2.17 wizard_progress.status
-- =========================================================================
-- EXISTING: wizard_progress_status_check allows (in_progress, submitted, reviewed)
-- Already correct. No change needed.

-- =========================================================================
-- 2.18 pending_activations.status
-- =========================================================================
-- EXISTING: pending_activations_status_check allows (awaiting_payment, payment_confirmed, activated, expired, cancelled)
-- Already correct. No change needed.

-- =========================================================================
-- 2.19 referrals.status
-- =========================================================================
-- EXISTING: referrals_status_check allows (pending, converted, credited, paid)
-- Missing 'cancelled'. Replace to add it.
BEGIN;
ALTER TABLE referrals DROP CONSTRAINT IF EXISTS referrals_status_check;
ALTER TABLE referrals
  ADD CONSTRAINT chk_referrals_status
  CHECK (status IN ('pending', 'converted', 'credited', 'paid', 'cancelled'));
COMMIT;

-- =========================================================================
-- 2.20 signature_requests.status
-- =========================================================================
-- No existing constraint. Add new.
BEGIN;
ALTER TABLE signature_requests
  ADD CONSTRAINT chk_sigreq_status
  CHECK (status IN ('draft', 'awaiting_signature', 'signed'));
COMMIT;

-- =========================================================================
-- 2.21 contacts.portal_tier
-- =========================================================================
-- No existing constraint. Add new. Allow NULL.
BEGIN;
ALTER TABLE contacts
  ADD CONSTRAINT chk_contact_portal_tier
  CHECK (portal_tier IS NULL OR portal_tier IN ('lead', 'onboarding', 'active'));
COMMIT;

-- =========================================================================
-- 2.22 contacts.portal_role
-- =========================================================================
-- EXISTING: contacts_portal_role_check allows (client, partner)
-- Already correct (NULLs pass because CHECK only rejects when expression = FALSE).

-- =========================================================================
-- 2.23 accounts.portal_tier
-- =========================================================================
-- No existing constraint. Add new. Allow NULL.
BEGIN;
ALTER TABLE accounts
  ADD CONSTRAINT chk_account_portal_tier
  CHECK (portal_tier IS NULL OR portal_tier IN ('lead', 'onboarding', 'active'));
COMMIT;

-- =========================================================================
-- 2.24 tasks.status
-- =========================================================================
-- tasks.status is an ENUM (task_status). No CHECK constraint needed.
-- Postgres enforces allowed values via the ENUM type definition.
-- Current ENUM labels: To Do, In Progress, Waiting, Done, Cancelled


-- #############################################################################
-- STEP 3: ROLLBACK / DROP CONSTRAINT STATEMENTS
-- #############################################################################
-- Run these to remove the constraints added in Step 2.
-- Only includes constraints that Step 2 actually adds or replaces.
-- Does NOT remove pre-existing constraints that were left unchanged.
-- #############################################################################

/*

-- 2.1: service_deliveries.status
ALTER TABLE service_deliveries DROP CONSTRAINT IF EXISTS chk_sd_status;

-- 2.2: service_deliveries.service_type
ALTER TABLE service_deliveries DROP CONSTRAINT IF EXISTS chk_sd_service_type;

-- 2.3: offers.status (only if you uncommented the replacement above)
-- ALTER TABLE offers DROP CONSTRAINT IF EXISTS chk_offers_status;
-- ALTER TABLE offers ADD CONSTRAINT offers_status_check
--   CHECK (status::text IN ('draft','sent','viewed','accepted','signed','completed','expired'));

-- 2.4: lease_agreements.status
ALTER TABLE lease_agreements DROP CONSTRAINT IF EXISTS chk_lease_status;

-- 2.6: ss4_applications.status
ALTER TABLE ss4_applications DROP CONSTRAINT IF EXISTS chk_ss4_status;

-- 2.7: deadlines.status
ALTER TABLE deadlines DROP CONSTRAINT IF EXISTS chk_deadline_status;

-- 2.9: client_invoices.status — restore original
ALTER TABLE client_invoices DROP CONSTRAINT IF EXISTS chk_client_invoices_status;
ALTER TABLE client_invoices ADD CONSTRAINT client_invoices_status_check
  CHECK (status IN ('Draft', 'Sent', 'Paid', 'Overdue', 'Cancelled'));

-- 2.19: referrals.status — restore original
ALTER TABLE referrals DROP CONSTRAINT IF EXISTS chk_referrals_status;
ALTER TABLE referrals ADD CONSTRAINT referrals_status_check
  CHECK (status IN ('pending', 'converted', 'credited', 'paid'));

-- 2.20: signature_requests.status
ALTER TABLE signature_requests DROP CONSTRAINT IF EXISTS chk_sigreq_status;

-- 2.21: contacts.portal_tier
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS chk_contact_portal_tier;

-- 2.23: accounts.portal_tier
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS chk_account_portal_tier;

*/
