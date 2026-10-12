-- Bank of America intake (dev job 11d484a4): a one-time link a client (our own OR an external
-- one such as a Max Scale client) fills out to apply for a business bank account through the
-- third-party intermediary. Everything the client types and uploads is stored HERE; nothing is
-- forwarded to the intermediary by this migration or by v1 of the feature.
--
-- One row per link. The link is "one-time": the first browser to open it is locked in
-- (opener_hash = SHA-256 of a secret kept in that browser's cookie); anyone else sees "already
-- used". The row dies for good when `status` becomes 'completed' or 'revoked'.
--
-- Private bucket `bofa-intake-uploads`: files are uploaded by the browser straight to storage
-- through a signed link the server mints only after checking the lock (no anon access to the bucket).
--
-- Idempotent. Production: apply via the Supabase dashboard (R105) only on Antonio's explicit word;
-- sandbox / local: node scripts/apply-migration.js <file>.

CREATE TABLE IF NOT EXISTS public.bofa_intake_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token         text NOT NULL UNIQUE,
  label         text NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'opened', 'completed', 'revoked')),
  opener_hash   text,
  opened_at     timestamptz,
  completed_at  timestamptz,
  form_data     jsonb,
  files         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by    text,
  client_ip     text,
  client_user_agent text,
  notified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Internal-only table (convention: no client / partner / anon policy at all; the app reads and
-- writes it only through the service role).
ALTER TABLE public.bofa_intake_requests ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS bofa_intake_requests_created_idx
  ON public.bofa_intake_requests (created_at DESC);

-- Storage itself enforces what may land in the bucket (the signed upload link does not restrict the
-- content type), so a client cannot put an HTML page or an executable under a "passport" box.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('bofa-intake-uploads', 'bofa-intake-uploads', false, 10485760,  -- 10 MiB
        ARRAY['application/pdf','image/jpeg','image/png','image/heic','image/heif','image/webp'])
ON CONFLICT (id) DO UPDATE SET file_size_limit = 10485760, public = false,
  allowed_mime_types = ARRAY['application/pdf','image/jpeg','image/png','image/heic','image/heif','image/webp'];
