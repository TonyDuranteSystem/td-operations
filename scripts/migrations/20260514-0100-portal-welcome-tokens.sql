-- Portal Welcome Tokens — shareable credentials page for first-contact leads.
--
-- The Welcome Link is an ADDITIONAL delivery channel for portal access
-- credentials. The portal-access email still always sends; this table backs a
-- token-keyed page at `${APP_BASE_URL}/welcome/<token>` that staff can share
-- via WhatsApp / Telegram / SMS when the client confirms they did not receive
-- the email or asks for a quicker way in.
--
-- Encryption: `encrypted_password` stores the temp password ciphertext
-- produced by lib/portal/welcome-token.ts (AES-256-GCM keyed off the token
-- UUID). Only someone holding the token URL can decrypt. The DB never sees
-- the plaintext key.
--
-- Expiry: rows carry `expires_at` (7 days from creation). After that the
-- welcome page renders an "expired" notice instead of credentials. The
-- portal-access email still works after expiry — clients can also reset
-- their password from the portal login flow.

CREATE TABLE IF NOT EXISTS portal_welcome_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  contact_id UUID REFERENCES contacts(id),
  email TEXT NOT NULL,
  encrypted_password TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  source TEXT NOT NULL DEFAULT 'offer',
  source_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  first_viewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_welcome_tokens_token ON portal_welcome_tokens(token);
CREATE INDEX IF NOT EXISTS idx_portal_welcome_tokens_email ON portal_welcome_tokens(email);
CREATE INDEX IF NOT EXISTS idx_portal_welcome_tokens_source ON portal_welcome_tokens(source, source_id);

-- Service role bypasses RLS; admins and the welcome page access via supabaseAdmin.
-- No public policies — the encrypted_password is the sensitive payload.
ALTER TABLE portal_welcome_tokens ENABLE ROW LEVEL SECURITY;
