-- Undo of 20261120-1930-team-personal-docs-shares.sql.
-- WARNING: dropping the table switches every team login's access to shared personal documents OFF (the 'powers_changed' lines in the team record stay).
DROP TABLE IF EXISTS portal_team_document_shares;
