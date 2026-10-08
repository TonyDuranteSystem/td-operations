-- Client invoicing Phase 2 (dev job 1a23f5f1, plan: sysdoc client-invoicing-plan).
-- 1) portal_user_preferences: ONE small general per-login preference store (key -> value). First use: whether
--    this person finished / dismissed the invoicing tour (key 'tour.invoicing'). Keyed by the sign-in user id,
--    so it covers clients AND team members (a team member has a login but no contact record).
--    RLS on, no policies: only the server (service role) reads or writes it, through /api/portal/preferences.
-- 2) catalog 'portal_guides': optional rows that REPLACE the built-in tour/checklist
--    (slugs tour-invoicing, checklist-invoicing). No row = the built-in default; a row that does not validate
--    is ignored. Edited with Claude through the catalog tools.
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.portal_user_preferences (
  auth_user_id uuid PRIMARY KEY,
  prefs        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.portal_user_preferences ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.portal_user_preferences IS
  'Per-login portal preferences (key -> value), e.g. tour.invoicing = {"status":"completed","version":1}. Server-only access (RLS on, no policies).';

INSERT INTO catalog_definitions (id, display_name, description, admin_can_add_rows) VALUES
  ('portal_guides','Portal guides','Optional replacements for the client portal''s built-in guided tours and setup checklists. Slugs: tour-invoicing (metadata = {id, version, steps[]}), checklist-invoicing (metadata = {id, items[]}). A step can only point at a screen marker, tab and text key that code already knows; a row that does not validate is ignored and the built-in default is used. See lib/portal/guides/guides.ts.', true)
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name, description = EXCLUDED.description, updated_at = now();
