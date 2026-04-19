-- ============================================================
-- TD Operations - Sandbox Test Data
-- 1 test account + 1 test contact
-- Run AFTER schema and seed data are applied
-- ============================================================

-- Test account (Sandbox Test LLC)
INSERT INTO accounts (
  id, company_name, entity_type, status, account_type,
  state_of_formation, portal_tier, is_test, created_at, updated_at
) VALUES (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'Sandbox Test LLC',
  'Single Member LLC',
  'Active',
  'Client',
  'Florida',
  'active',
  TRUE,
  now(), now()
) ON CONFLICT (id) DO NOTHING;

-- Test contact
INSERT INTO contacts (
  id, full_name, first_name, last_name, email, is_test, created_at, updated_at
) VALUES (
  'bbbbbbbb-0000-0000-0000-000000000001',
  'Sandbox Test',
  'Sandbox',
  'Test',
  'sandbox@test.internal',
  TRUE,
  now(), now()
) ON CONFLICT (id) DO NOTHING;

-- Link contact to account
INSERT INTO account_contacts (account_id, contact_id, role)
VALUES (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001',
  'Primary'
) ON CONFLICT (account_id, contact_id) DO NOTHING;

-- Create portal access for sandbox test client
-- Note: auth user must be created via Supabase Dashboard Auth (no SQL access to auth schema here)
-- Test client credentials to create in dashboard:
--   Email: sandbox.client@test.internal
--   Password: TDsandbox-client-2026!

