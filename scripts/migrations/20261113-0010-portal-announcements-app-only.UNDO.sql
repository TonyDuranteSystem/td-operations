-- Undo of 20261113-0010-portal-announcements-app-only.sql (drops the column; any app-only announcement then shows everywhere, so delete or deactivate those first).
ALTER TABLE portal_announcements DROP COLUMN IF EXISTS app_only;
