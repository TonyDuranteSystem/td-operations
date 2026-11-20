-- Photos, voice notes, videos and files sent by MEMBERS of a WhatsApp GROUP (2026-11-20, Antonio's full audit of groups).
-- Until now the Mac's media downloader only ever claimed items from one-to-one chats, so in a group they stayed as the
-- placeholders "[Photo]" / "[Voice note]" / "[Document]" and could not be opened.
-- wabridge_media_claim is rewritten IN PLACE from the live definition (two lines): it now also claims items from a group chat and
-- hands the Mac the group's own id (`<digits>@g.us`) in `chat_digits` (a one-to-one chat still gets plain digits). Refuses to run if
-- a line is not found; safe to run twice (marker `-- group-media`). Every other rule (25-day limit, 3 attempts, order) is unchanged.
-- The Mac downloader (~/wa-bridge/media-loop.sh, outside the repo) must be updated to accept and use a group id.

DO $mig$
DECLARE
  v_oid oid;
  v_def text;
  v_new text;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'wabridge_media_claim';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'group-media: wabridge_media_claim not found';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF position('-- group-media' IN v_def) > 0 THEN
    RETURN;
  END IF;
  v_new := replace(v_def,
    $a$AND g.external_group_id ~ '^[0-9]{6,15}(@c\.us)?$'$a$,
    $b$AND (g.external_group_id ~ '^[0-9]{6,15}(@c\.us)?$' OR g.external_group_id ~ '^[0-9]{8,30}(-[0-9]+)?@g\.us$') -- group-media$b$);
  IF v_new = v_def THEN
    RAISE EXCEPTION 'group-media: the chat-key guard was not found';
  END IF;
  v_def := v_new;
  v_new := replace(v_def,
    $a$'chat_digits', regexp_replace(v_row.external_group_id, '\D', '', 'g'),$a$,
    $b$'chat_digits', CASE WHEN v_row.external_group_id ~ '@g\.us$' THEN v_row.external_group_id ELSE regexp_replace(v_row.external_group_id, '\D', '', 'g') END,$b$);
  IF v_new = v_def THEN
    RAISE EXCEPTION 'group-media: the chat_digits line was not found';
  END IF;
  EXECUTE v_new;
END
$mig$;
