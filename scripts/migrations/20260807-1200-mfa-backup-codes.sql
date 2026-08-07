-- mfa_backup_codes — one-shot recovery codes for staff MFA (dev job de4564ee)
--
-- Design (council-fixed):
--  * Codes are >=128-bit random (crypto.getRandomValues), generated at
--    enrollment, shown/downloaded ONCE. Only SHA-256 hashes stored — the
--    unsalted hash is acceptable ONLY because codes are high-entropy and
--    never user-chosen (Security review constraint).
--  * A backup code is ONE-SHOT RECOVERY, never a login method: using one
--    deletes the user's TOTP factors and forces fresh re-enrollment. It
--    never mints device trust (Architect blocker).
--  * Single-use enforced by conditional UPDATE ... WHERE used_at IS NULL
--    RETURNING (the codebase's TOCTOU pattern), not read-then-write.
--  * Service-role only: RLS enabled, ZERO policies.

CREATE TABLE IF NOT EXISTS mfa_backup_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  code_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);

ALTER TABLE mfa_backup_codes ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: service-role only.

CREATE INDEX IF NOT EXISTS idx_mfa_backup_codes_user
  ON mfa_backup_codes (user_id) WHERE used_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mfa_backup_codes_hash
  ON mfa_backup_codes (code_hash);
