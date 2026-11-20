-- Undo of 20261120-0300-wabridge-group-media.sql: groups are skipped by the media downloader again.
DO $mig$
DECLARE v_oid oid; v_def text; v_new text;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'wabridge_media_claim';
  v_def := pg_get_functiondef(v_oid);
  v_new := replace(v_def,
    $a$AND (g.external_group_id ~ '^[0-9]{6,15}(@c\.us)?$' OR g.external_group_id ~ '^[0-9]{8,30}(-[0-9]+)?@g\.us$') -- group-media$a$,
    $b$AND g.external_group_id ~ '^[0-9]{6,15}(@c\.us)?$'$b$);
  v_new := replace(v_new,
    $a$'chat_digits', CASE WHEN v_row.external_group_id ~ '@g\.us$' THEN v_row.external_group_id ELSE regexp_replace(v_row.external_group_id, '\D', '', 'g') END,$a$,
    $b$'chat_digits', regexp_replace(v_row.external_group_id, '\D', '', 'g'),$b$);
  IF v_new <> v_def THEN EXECUTE v_new; END IF;
END
$mig$;
