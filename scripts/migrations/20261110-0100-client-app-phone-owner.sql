-- Client iPhone app, Step 4 (dev job 056a70d0): who a registered phone belongs to, as a portal person.
--
-- The saved-phones table knows the LOGIN (user_id) of each phone, but nothing in the database links a client contact back to its login (the link lives only
-- inside the login's token). To tell "this company's phones" or "this client's phones" apart at send time, the phone now carries two optional facts, written
-- from the signed-in session when the app registers the phone (never from the request):
--   contact_id       the client contact this phone's login is (a client login)
--   team_account_id  the company a team member (added by a client) belongs to
-- Both stay NULL for TD Social (staff) phones. They are only a pointer: the sender re-checks the live links (account_contacts, portal_team_members) before it sends.
-- No foreign keys on purpose: a deleted contact must never block or cascade into the phone list.
-- Safe to run before the code that uses it; run it on production BEFORE the client app switch is turned on.

ALTER TABLE public.social_app_devices ADD COLUMN IF NOT EXISTS contact_id uuid;
ALTER TABLE public.social_app_devices ADD COLUMN IF NOT EXISTS team_account_id uuid;

CREATE INDEX IF NOT EXISTS social_app_devices_contact_idx
  ON public.social_app_devices (contact_id) WHERE revoked_at IS NULL AND contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS social_app_devices_team_account_idx
  ON public.social_app_devices (team_account_id) WHERE revoked_at IS NULL AND team_account_id IS NOT NULL;
