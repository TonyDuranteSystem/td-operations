-- Undo of 20261106-2000-marketing-test-team-flag.sql: removes the test-team marker. The code that reads it must be rolled back first.
ALTER TABLE marketing_teams DROP COLUMN IF EXISTS is_test;
