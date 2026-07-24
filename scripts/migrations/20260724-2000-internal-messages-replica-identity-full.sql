-- Team Workspace — internal_messages must send the OLD row on UPDATE, so the
-- in-CRM pop-up can tell "Claude's answer arrived" from "someone edited a
-- message".
--
-- WHY THIS EXISTS. An @claude answer in Team Chat is not an INSERT: the trigger
-- posts a "…" placeholder and the processor REPLACES its body with the answer.
-- So the global toast listener, which only listened to INSERT, popped a
-- notification saying literally "…" and never showed the answer. Adding an
-- UPDATE listener is only half the fix — to know that a particular UPDATE turned
-- a placeholder into an answer (rather than being an edit, a soft delete, or a
-- reaction toggle, which are also UPDATEs on this table) the listener needs the
-- PREVIOUS body, and Supabase Realtime only sends it when the table is REPLICA
-- IDENTITY FULL. With the default, `payload.old` carries the primary key alone —
-- verified on sandbox 2026-07-24: internal_messages was 'd', so the UPDATE
-- branch would have been dead code and the "…" toast would have survived the fix.
--
-- PRECEDENT + COST: portal_messages is already FULL for the same class of reason.
-- The cost is WAL volume — the old row is written on every UPDATE — and this
-- table is tiny (the busiest channel holds ~33 messages), with updates limited to
-- edits, soft deletes, reactions and Claude's placeholder rewrite.
--
-- PRIVACY NOTE: FULL means the previous body travels to every realtime
-- subscriber of this table. Subscribers are staff only — enforced by the RLS
-- change in 20260724-1900, which excludes partners as well as clients. Apply
-- that migration FIRST or together with this one; the ordering matters.

-- ⚠️ SANDBOX / PRODUCTION DRIFT, found while verifying this (2026-07-24):
-- internal_messages is in the `supabase_realtime` publication on PRODUCTION but
-- was NOT on sandbox. So team-chat realtime — the floating chat, the live
-- message stream, and this toast — silently does nothing on sandbox while
-- working in production. Any sandbox QA of a realtime behaviour would have
-- "failed" for a reason that does not exist in prod. Added below, guarded, so
-- both environments state the same thing and running this on prod is a no-op.

ALTER TABLE public.internal_messages REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'internal_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.internal_messages;
  END IF;
END $$;
