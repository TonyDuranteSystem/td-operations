-- Operating Agreement: a company can have a manager who is not an owner (dev job d016d398).
-- Blank = today's behaviour (the manager is the flagged signer). Nullable, no default.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS manager_name text;
COMMENT ON COLUMN accounts.manager_name IS 'Name printed as Manager on new Operating Agreements. NULL = the company''s flagged signer.';
