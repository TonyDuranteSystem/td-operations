-- Team Workspace — atomic "delete a thread I alone posted in".
--
-- The first cut did the guard in the API route: SELECT the reply senders, decide
-- in JavaScript, then DELETE. That leaves a window a full network round-trip
-- wide — a teammate replying in that gap has their message silently destroyed by
-- the delete that follows, which is the ONE outcome archive exists to prevent.
--
-- Moving the whole thing into a function collapses the check and the delete into
-- a single transaction, so the app-level window is gone.
--
-- The remaining sub-millisecond window (a reply committing between the in-function
-- count and the root DELETE, under READ COMMITTED) is closed by CONSEQUENCE
-- rather than by locking: any straggler reply is PROMOTED to a top-level message
-- instead of being deleted or left as an invisible orphan. Nothing is lost either
-- way. Full serialisation would need the send path to take the same lock, which
-- is a heavy price for a two-person internal chat.
--
-- Returns a status string the route maps to an HTTP code:
--   'deleted' | 'not_found' | 'not_a_thread' | 'not_author' | 'has_other_replies'

CREATE OR REPLACE FUNCTION public.delete_thread_if_sole_author(
  p_root_id uuid,
  p_user_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sender uuid;
  v_root_id uuid;
  v_thread uuid;
  v_others int;
BEGIN
  -- Lock the root so two concurrent deletes can't both proceed.
  SELECT sender_id, root_id, thread_id INTO v_sender, v_root_id, v_thread
    FROM public.internal_messages
   WHERE id = p_root_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  -- Must be a ROOT, not a reply. Without this, passing a reply's id would let
  -- its author hard-delete a single reply, bypassing the soft-delete/tombstone
  -- path every other message deletion uses (council).
  IF v_root_id IS NOT NULL THEN
    RETURN 'not_a_thread';
  END IF;

  -- A NULL sender is treated as someone else, not as nobody: legacy or imported
  -- rows must never fall through the "I am the only poster" test.
  IF v_sender IS NULL OR v_sender IS DISTINCT FROM p_user_id THEN
    RETURN 'not_author';
  END IF;

  -- Anyone else in here — including Claude — and delete is off the table.
  -- Deliberately NOT filtered on deleted_at: a reply someone else already
  -- soft-deleted is still THEIR row, preserved on purpose (R100 keeps the body
  -- and deleted_by as the audit trail). Counting only live replies would let a
  -- delete destroy that record — the gate would pass precisely because the
  -- evidence had been tidied away.
  -- Every reply is scoped to the root's OWN thread. root_id carries no foreign
  -- key and no constraint, so an unscoped sweep would reach any row anywhere
  -- that happened to carry this value.
  SELECT count(*) INTO v_others
    FROM public.internal_messages
   WHERE root_id = p_root_id
     AND thread_id = v_thread
     AND sender_id IS DISTINCT FROM p_user_id;
  IF v_others > 0 THEN
    RETURN 'has_other_replies';
  END IF;

  -- Only ever my own rows. Never a blanket delete by root_id — that would take
  -- anyone else's rows with it, including ones they soft-deleted themselves
  -- (whose preserved body IS the audit trail under R100).
  DELETE FROM public.internal_messages
   WHERE root_id = p_root_id
     AND thread_id = v_thread
     AND sender_id = p_user_id;

  -- Anything still attached arrived in the race window. Promote it to a
  -- top-level message rather than deleting or orphaning it — root_id carries no
  -- foreign key, so an orphan would simply vanish from every view.
  UPDATE public.internal_messages
     SET root_id = NULL
   WHERE root_id = p_root_id
     AND thread_id = v_thread;

  -- internal_thread_state / internal_root_follows / internal_root_reads all
  -- cascade off internal_messages(id), so this clears the sidecars too.
  DELETE FROM public.internal_messages WHERE id = p_root_id;

  RETURN 'deleted';
END;
$$;
