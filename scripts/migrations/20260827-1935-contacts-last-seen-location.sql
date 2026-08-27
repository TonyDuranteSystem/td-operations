-- Passive capture of a client's last real connection location/timezone
-- (from Vercel's IP-geolocation request headers, taken on a genuine client
-- portal visit — never during staff "View as client"). Lets the portal's
-- "Your Time" clock show, under View-as, where the client's own connection
-- actually was most recently, instead of only the static address on file.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS last_seen_timezone TEXT,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
