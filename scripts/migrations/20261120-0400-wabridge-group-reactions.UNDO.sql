-- Undo of 20261120-0400-wabridge-group-reactions.sql: reactions are one-to-one only again.
-- The queue function is reversed in place. The observed-reactions function carries several inserted pieces; to undo it, re-apply the
-- earlier definition from scripts/migrations/20261007-0100-wabridge-phone-reactions.sql (CREATE OR REPLACE) — reactions already stored
-- for group members stay in messages.reactions (harmless; they simply stop updating).
DO $mig$
DECLARE v_oid oid; v_def text; v_new text;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'wabridge_queue_phone_reaction';
  v_def := pg_get_functiondef(v_oid);
  v_new := replace(v_def,
    $a$m.external_group_id !~ '^[0-9]{6,15}(@(s\.whatsapp\.net|c\.us))?$' AND m.external_group_id !~ '^[0-9]{8,30}(-[0-9]+)?@g\.us$' THEN -- group-reactions$a$,
    $b$m.external_group_id !~ '^[0-9]{6,15}(@(s\.whatsapp\.net|c\.us))?$' THEN$b$);
  v_new := replace(v_new,
    $a$v_digits := CASE WHEN m.external_group_id ~ '@g\.us$' THEN m.external_group_id ELSE regexp_replace(m.external_group_id, '@.*$', '') END;$a$,
    $b$v_digits := regexp_replace(m.external_group_id, '@.*$', '');$b$);
  IF v_new <> v_def THEN EXECUTE v_new; END IF;
END
$mig$;
