-- Undo of 20261120-0100-wabridge-group-send.sql: the same in-place rewrite, backwards (groups refused again).
DO $mig$
DECLARE r record; v_def text; v_new text;
BEGIN
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname IN ('wabridge_enqueue_reply', 'wabridge_enqueue_send')
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := replace(v_def,
      $a$IF v_key !~ '^[0-9]{6,15}(@c\.us)?$' AND v_key !~ '^[0-9]{8,30}(-[0-9]+)?@g\.us$' THEN -- group-send$a$,
      $b$IF v_key !~ '^[0-9]{6,15}(@c\.us)?$' THEN$b$);
    v_new := replace(v_new,
      $a$v_digits := CASE WHEN v_key ~ '@g\.us$' THEN v_key ELSE regexp_replace(v_key, '\D', '', 'g') END;$a$,
      $b$v_digits := regexp_replace(v_key, '\D', '', 'g');$b$);
    IF v_new <> v_def THEN EXECUTE v_new; END IF;
  END LOOP;
END
$mig$;
