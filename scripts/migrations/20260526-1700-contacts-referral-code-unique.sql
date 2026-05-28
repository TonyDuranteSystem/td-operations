-- Race-safe referral codes: a case-insensitive unique index on contacts.referral_code.
-- Lets ensureReferralCode() generate codes on-demand without two concurrent portal
-- loads creating duplicate codes for different contacts. Partial — only non-null codes
-- are constrained (most contacts have no code).
CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_referral_code_ci
  ON contacts (lower(referral_code))
  WHERE referral_code IS NOT NULL;
