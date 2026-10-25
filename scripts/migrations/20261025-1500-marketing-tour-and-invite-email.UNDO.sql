-- UNDO for 20261025-1500-marketing-tour-and-invite-email.sql. Forgets which tours were seen (they would start again) and which invitations were emailed.
DROP TABLE IF EXISTS marketing_tour_seen;
ALTER TABLE marketing_invites DROP COLUMN IF EXISTS emailed_by;
ALTER TABLE marketing_invites DROP COLUMN IF EXISTS emailed_at;
