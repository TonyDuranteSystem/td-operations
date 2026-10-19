-- Undo for 20261017-1900-marketing-p0-settings.sql. Drops the four new tables and their functions. Nothing else depends on them yet.
DROP TABLE IF EXISTS marketing_commission_terms;
DROP TABLE IF EXISTS marketing_settings_history;
DROP TABLE IF EXISTS marketing_settings;
DROP TABLE IF EXISTS marketing_teams;
DROP FUNCTION IF EXISTS marketing_settings_log();
DROP FUNCTION IF EXISTS marketing_block_change();
