-- UNDO for 20261105-0300-social-app-user-state.sql (TD Social switches and "last opened" times). Removes the table, its data and both functions.
DROP FUNCTION IF EXISTS public.social_app_merge_prefs(uuid, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.social_app_mark_inbox_opened(uuid, text, timestamptz, boolean);
DROP TABLE IF EXISTS public.social_app_user_state;
