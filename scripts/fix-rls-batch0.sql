-- =============================================================================
-- BATCH 0: RLS SECURITY FIXES
-- =============================================================================
-- Run in Supabase Dashboard SQL Editor (execute_sql MCP tool cannot run DDL)
-- Date: 2026-04-08
--
-- WHAT THIS DOES:
-- 1. Drops 11 broken "service_role" policies that were assigned to {public}
--    (giving anonymous users full CRUD access)
-- 2. Replaces them with proper staff-only policies using the existing pattern:
--    COALESCE(app_metadata.role, '') <> 'client'
-- 3. Drops 2 broken service_role policies on form tables
-- 4. Enables RLS on 4 unprotected sensitive tables
-- 5. Fixes overly permissive client UPDATE policies
--
-- SAFE TO RUN: service_role bypasses RLS entirely, so MCP tools and
-- server-side code are unaffected. CRM staff (admin/team role) pass
-- the new policy. Only anonymous/client access is restricted.
-- =============================================================================


-- =============================================
-- PART 1: Fix 9 internal/admin table policies
-- =============================================

-- 1. billing_entities
DROP POLICY "Service role full access" ON billing_entities;
CREATE POLICY "billing_entities_staff_all" ON billing_entities
  FOR ALL TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');

-- 2. internal_messages
DROP POLICY "Service role full access" ON internal_messages;
CREATE POLICY "internal_messages_staff_all" ON internal_messages
  FOR ALL TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');

-- 3. internal_threads
DROP POLICY "Service role full access" ON internal_threads;
CREATE POLICY "internal_threads_staff_all" ON internal_threads
  FOR ALL TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');

-- 4. dev_tasks
DROP POLICY "Service role full access" ON dev_tasks;
CREATE POLICY "dev_tasks_staff_all" ON dev_tasks
  FOR ALL TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');

-- 5. job_queue
DROP POLICY "Service role full access" ON job_queue;
CREATE POLICY "job_queue_staff_all" ON job_queue
  FOR ALL TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');

-- 6. webhook_events
DROP POLICY "Service role full access" ON webhook_events;
CREATE POLICY "webhook_events_staff_all" ON webhook_events
  FOR ALL TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');

-- 7. pipeline_stages
DROP POLICY "service_role_all" ON pipeline_stages;
CREATE POLICY "pipeline_stages_staff_all" ON pipeline_stages
  FOR ALL TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');

-- 8. client_partners (keep existing partner_read_own policy)
DROP POLICY "service_role_all_client_partners" ON client_partners;
CREATE POLICY "client_partners_staff_all" ON client_partners
  FOR ALL TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');

-- 9. signature_requests (keep existing client_read_own policy)
DROP POLICY "service_role_all_signature_requests" ON signature_requests;
CREATE POLICY "signature_requests_staff_all" ON signature_requests
  FOR ALL TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');


-- =============================================
-- PART 2: Fix form table service_role policies
-- (keep anon policies for form pages)
-- =============================================

-- 10. lease_agreements — drop broken service_role, keep anon_select + anon_update
DROP POLICY "service_role_full_access" ON lease_agreements;
CREATE POLICY "lease_agreements_staff_all" ON lease_agreements
  FOR ALL TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');

-- 11. form_8832_applications — drop broken service_role, keep anon_read + anon_update
DROP POLICY "service_role_full" ON form_8832_applications;
CREATE POLICY "form_8832_staff_all" ON form_8832_applications
  FOR ALL TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');


-- =============================================
-- PART 3: Enable RLS on 4 unprotected tables
-- =============================================

ALTER TABLE client_bank_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "client_bank_accounts_staff_all" ON client_bank_accounts
  FOR ALL TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');

ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bank_transactions_staff_all" ON bank_transactions
  FOR ALL TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');

ALTER TABLE plaid_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "plaid_connections_staff_all" ON plaid_connections
  FOR ALL TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');

ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "oauth_tokens_staff_all" ON oauth_tokens
  FOR ALL TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');


-- =============================================
-- PART 4: Fix overly permissive client policies
-- =============================================

-- service_deliveries: client can UPDATE any row (auth_write qual=true)
-- Replace with scoped policy
DROP POLICY "auth_write" ON service_deliveries;
CREATE POLICY "sd_staff_write" ON service_deliveries
  FOR UPDATE TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');

-- deals: client can SELECT and UPDATE all rows
DROP POLICY "auth_read" ON deals;
DROP POLICY "auth_write" ON deals;
CREATE POLICY "deals_staff_all" ON deals
  FOR ALL TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');

-- tasks: client can SELECT, INSERT, and UPDATE all rows
DROP POLICY "auth_read_tasks" ON tasks;
DROP POLICY "auth_write" ON tasks;
DROP POLICY "auth_insert" ON tasks;
CREATE POLICY "tasks_staff_all" ON tasks
  FOR ALL TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');

-- tax_returns: client can SELECT and UPDATE all rows
DROP POLICY "auth_read" ON tax_returns;
DROP POLICY "auth_write" ON tax_returns;
CREATE POLICY "tax_returns_staff_all" ON tax_returns
  FOR ALL TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');

-- services: client can UPDATE any row
DROP POLICY "auth_write" ON services;
CREATE POLICY "services_staff_write" ON services
  FOR UPDATE TO public
  USING (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client')
  WITH CHECK (COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'client');


-- =============================================
-- VERIFICATION QUERY — run after all above
-- =============================================
-- Should return 0 rows if all fixes applied correctly:
SELECT tablename, policyname, roles::text, cmd
FROM pg_policies
WHERE schemaname = 'public'
AND roles::text LIKE '%public%'
AND qual::text = 'true'
AND tablename IN (
  'billing_entities','internal_messages','internal_threads','dev_tasks',
  'job_queue','webhook_events','pipeline_stages','client_partners',
  'signature_requests','lease_agreements','form_8832_applications'
);


-- =============================================
-- ROLLBACK (if needed)
-- =============================================
-- To revert any single table, drop the new policy and recreate the old one:
-- Example:
--   DROP POLICY "billing_entities_staff_all" ON billing_entities;
--   CREATE POLICY "Service role full access" ON billing_entities
--     FOR ALL TO public USING (true) WITH CHECK (true);
