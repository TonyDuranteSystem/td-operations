-- Client iPhone app (dev job 056a70d0): an announcement can be limited to the client app.
-- app_only = false (default, every existing row): shown to every client on the website and in the app, exactly as before.
-- app_only = true: shown ONLY inside the client iPhone app (News button + floating banner); the website portal home never draws it.
-- Deliberately a plain boolean with NO CHECK constraint (a new value-list CHECK on the shared sandbox turns every other session's CI red).
-- Additive and safe to run on production BEFORE the code that reads it ships: old code ignores the column.
ALTER TABLE portal_announcements ADD COLUMN IF NOT EXISTS app_only boolean NOT NULL DEFAULT false;
