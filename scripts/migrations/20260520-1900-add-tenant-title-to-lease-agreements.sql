-- Add configurable tenant_title to lease_agreements.
-- Replaces the hardcoded "Owner/Member" label in the lease template.
-- Default 'Manager' matches the manager-managed structure of all client LLCs.
ALTER TABLE lease_agreements
  ADD COLUMN IF NOT EXISTS tenant_title VARCHAR(100) NOT NULL DEFAULT 'Manager';
