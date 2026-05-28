-- Referral click log: one row per visit to /r/[code]. Powers click analytics
-- ("how many people opened a client's link") and is a first-party signal that a
-- referral link was used, independent of Calendly. Append-only; no PII beyond UA/referer.
CREATE TABLE IF NOT EXISTS referral_clicks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_code text NOT NULL,
  referrer_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  user_agent text,
  referer text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referral_clicks_code ON referral_clicks (referral_code);
CREATE INDEX IF NOT EXISTS idx_referral_clicks_referrer ON referral_clicks (referrer_contact_id);
CREATE INDEX IF NOT EXISTS idx_referral_clicks_created ON referral_clicks (created_at DESC);
