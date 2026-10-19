-- UNDO for 20261018-1800-formation-submission-archive-marker.sql
DROP INDEX IF EXISTS idx_formation_submissions_unfiled;
ALTER TABLE formation_submissions DROP COLUMN IF EXISTS drive_archive_meta, DROP COLUMN IF EXISTS drive_archived_at;
