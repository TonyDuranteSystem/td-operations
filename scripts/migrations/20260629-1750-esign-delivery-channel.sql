-- Add delivery_channel to esign_signers to track HOW a signer was reached.
-- Enables the reminders cron to skip email for portal-channel signers (who are
-- reached via the portal notification system, not email).
--
-- DEFAULT 'email' backfills all existing signers — correct, since portal
-- delivery was not in use before this migration.

ALTER TABLE esign_signers
  ADD COLUMN IF NOT EXISTS delivery_channel TEXT NOT NULL DEFAULT 'email'
  CONSTRAINT esign_signers_delivery_channel_check
    CHECK (delivery_channel IN ('email', 'portal', 'none'));
