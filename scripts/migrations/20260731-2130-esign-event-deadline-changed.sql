-- E-sign audit trail: record a staff deadline change (dev job 4aab0d6f).
--
-- Staff can now change the deadline of a document that is already out with a
-- client (7 / 14 / 30 days). The client is NOT notified either way — Antonio's
-- decision, 2026-07-31: the deadline is visible in their portal anyway, and a
-- message about an administrative date change is noise.
--
-- Silent to the CLIENT is not the same as unrecorded. A deadline drives when a
-- signature stops being accepted, so a change to it must leave a trace saying
-- who moved it, when, from what, to what. Today's incident is the argument:
-- deadlines on six live client documents were moved by a mis-scoped update, and
-- the ONLY reason the original values were recoverable was that `reopened`
-- events had recorded them. An unrecorded change is one nobody can undo.
--
-- Same shape as 20260731-1830 (which added 'expired' + 'reopened'): the CHECK is
-- rewritten, metadata-only, under a short lock_timeout so it can never block the
-- app.
--
-- PROD: apply by hand in the Supabase SQL editor (prod DDL through execute_sql
-- is blocked). SANDBOX: node scripts/apply-migration.js <this file>.

SET lock_timeout = '5s';

ALTER TABLE public.esign_events
  DROP CONSTRAINT IF EXISTS esign_events_type_check;

ALTER TABLE public.esign_events
  ADD CONSTRAINT esign_events_type_check CHECK (event_type IN
    ('created','sent','viewed','signed','declined','completed','voided',
     'reminder_sent','consent_accepted','expired','reopened','deadline_changed'));
