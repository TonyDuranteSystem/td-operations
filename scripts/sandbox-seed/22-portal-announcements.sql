-- Portal Announcements — admin-managed banners shown to all portal clients.
-- Apply this in sandbox first: xjcxlmlpeywtwkhstjlw
-- Then in production: ydzipybqeebtpcvsbtvs
-- via Supabase Dashboard > SQL Editor > New Query > Paste > Run.

CREATE TABLE IF NOT EXISTS public.portal_announcements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  message     TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'info'
                CHECK (type IN ('info', 'warning', 'success')),
  active      BOOLEAN NOT NULL DEFAULT true,
  dismissible BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.portal_announcements ENABLE ROW LEVEL SECURITY;

-- Authenticated users (portal clients) can read active announcements
CREATE POLICY IF NOT EXISTS "portal_clients_read_active_announcements"
  ON public.portal_announcements
  FOR SELECT
  TO authenticated
  USING (active = true);

-- Service role (used by admin API routes) can do everything
-- (service role bypasses RLS by default)

-- First announcement: Relay international wire notice
INSERT INTO public.portal_announcements (title, message, type, active, dismissible)
VALUES (
  'Relay: Informazioni sui bonifici internazionali',
  'Se avete ricevuto un''email da Relay che vi informa che i bonifici internazionali sono ora disponibili e vi vengono richiesti documenti o informazioni, siamo in contatto con Relay per conoscere la procedura corretta. Non scriveteci per domande su Relay; vi faremo sapere non appena avremo una risposta da parte loro.',
  'info',
  true,
  true
)
ON CONFLICT DO NOTHING;
