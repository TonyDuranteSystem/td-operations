-- TD Marketing chat: pin a message (dev job 9aec66fa). A pinned message stays in the bar at the top of its chat for everyone who can see that message.
-- Both columns are optional and the code works without them (the pin button then says it could not pin), so this can run before or after the deploy.
ALTER TABLE marketing_lead_messages ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
ALTER TABLE marketing_lead_messages ADD COLUMN IF NOT EXISTS pinned_by UUID;
ALTER TABLE marketing_team_messages ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
ALTER TABLE marketing_team_messages ADD COLUMN IF NOT EXISTS pinned_by UUID;
