-- UNDO for 20261028-2300-marketing-chat-pin.sql. Drops every pin (the messages themselves stay). Run only on purpose.
ALTER TABLE marketing_lead_messages DROP COLUMN IF EXISTS pinned_at, DROP COLUMN IF EXISTS pinned_by;
ALTER TABLE marketing_team_messages DROP COLUMN IF EXISTS pinned_at, DROP COLUMN IF EXISTS pinned_by;
