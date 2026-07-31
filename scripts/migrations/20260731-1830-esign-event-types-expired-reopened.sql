-- E-sign audit trail: allow the event types the code already writes / is about
-- to write (dev job 4aab0d6f, from Luca's td-bug thread "E-Sign Tool - Expired
-- documents", 2026-07-31).
--
-- LIVE BUG THIS FIXES: esign_events_type_check has never included 'expired',
-- but lib/esign/reminders.ts has been inserting event_type='expired' on every
-- expiry since 2026-06-26. Postgres rejects it with 23514, supabase-js RETURNS
-- the error rather than throwing, and the call site discards it — so the insert
-- fails silently. Verified on production 2026-07-31: 6 envelopes in status
-- 'expired', ZERO rows in esign_events with event_type='expired'. The legal
-- audit trail has been losing every expiry event for over a month.
--
-- 'reopened' is added for the new staff Reopen action (an expired envelope gets
-- a new deadline and goes back in flight). It is load-bearing, not cosmetic:
-- the reminder cadence counts reminder_sent rows NEWER than the latest
-- 'reopened' event, so a reopened envelope gets a fresh reminder cycle instead
-- of staying capped by the two nudges it already used.
--
-- Manual-vs-automatic reminders are NOT a new event type — they are
-- discriminated by esign_events.metadata->>'source' ('manual' | 'auto'), the
-- same shape invoice reminders use (lib/billing/invoice-reminder.ts). metadata
-- is unconstrained jsonb, so no constraint change is needed for that.
--
-- Rewriting the CHECK is metadata-only (no table rewrite, no row validation
-- beyond a single pass) and the table is small, but the lock is ACCESS
-- EXCLUSIVE — hence the short lock_timeout so this can never block the app.
--
-- PROD: apply by hand in the Supabase SQL editor (prod DDL through execute_sql
-- is blocked). SANDBOX: node scripts/apply-migration.js <this file>.

SET lock_timeout = '5s';

ALTER TABLE public.esign_events
  DROP CONSTRAINT IF EXISTS esign_events_type_check;

ALTER TABLE public.esign_events
  ADD CONSTRAINT esign_events_type_check CHECK (event_type IN
    ('created','sent','viewed','signed','declined','completed','voided',
     'reminder_sent','consent_accepted','expired','reopened'));

COMMENT ON CONSTRAINT esign_events_type_check ON public.esign_events IS
  'Allowed audit event types. expired + reopened added 2026-07-31 (dev job 4aab0d6f): expired was being written and silently rejected since 2026-06-26; reopened backs the staff Reopen action and anchors the post-reopen reminder cycle. Manual vs automatic reminders live in metadata->>source, not in this list.';
