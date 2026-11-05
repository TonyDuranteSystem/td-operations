-- UNDO for 20261105-0400-social-app-alerted.sql. Safe: the table only remembers which messages already alerted (and nothing reads it until TD Social is switched on).
DROP FUNCTION IF EXISTS public.social_app_claim_alert(text, text, integer, integer, interval);
DROP TABLE IF EXISTS public.social_app_alerted;
