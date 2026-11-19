-- Replying to a WhatsApp GROUP from the CRM (2026-11-20, Antonio: "reply to a group from the CRM").
-- Until now both send-queue functions refused anything that was not a one-to-one phone chat. A group chat's key is its own
-- `<digits>@g.us` id; the queue column `wa_outbox.to_digits` is plain text, so for a group it simply holds that id.
-- Every other rule stays exactly as it is: the chat must be active, someone must have written in it before (reply-only),
-- sending must be switched on, the test-number list and the speed / same-text-to-many-chats limits still apply.
--
-- Written as an in-place rewrite of the LIVE definitions (not a copy), so it keeps whatever each database already has:
-- it replaces exactly two lines in each function and REFUSES to run if either line is not found (no silent no-op).
-- Safe to run twice (the second run finds the marker and skips).

DO $mig$
DECLARE
  r record;
  v_def text;
  v_new text;
  v_found integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('wabridge_enqueue_reply', 'wabridge_enqueue_send')
  LOOP
    v_found := v_found + 1;
    v_def := pg_get_functiondef(r.oid);
    IF position('-- group-send' IN v_def) > 0 THEN
      CONTINUE;
    END IF;
    v_new := replace(v_def,
      $a$IF v_key !~ '^[0-9]{6,15}(@c\.us)?$' THEN$a$,
      $b$IF v_key !~ '^[0-9]{6,15}(@c\.us)?$' AND v_key !~ '^[0-9]{8,30}(-[0-9]+)?@g\.us$' THEN -- group-send$b$);
    IF v_new = v_def THEN
      RAISE EXCEPTION 'group-send: the chat-key check was not found in %', r.proname;
    END IF;
    v_def := v_new;
    v_new := replace(v_def,
      $a$v_digits := regexp_replace(v_key, '\D', '', 'g');$a$,
      $b$v_digits := CASE WHEN v_key ~ '@g\.us$' THEN v_key ELSE regexp_replace(v_key, '\D', '', 'g') END;$b$);
    IF v_new = v_def THEN
      RAISE EXCEPTION 'group-send: the digits line was not found in %', r.proname;
    END IF;
    EXECUTE v_new;
  END LOOP;
  IF v_found <> 2 THEN
    RAISE EXCEPTION 'group-send: expected 2 functions, found %', v_found;
  END IF;
END
$mig$;
