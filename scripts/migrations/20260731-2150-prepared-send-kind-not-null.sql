-- PHASE 3 of the worker_prepared_sends portal-kind change. RUN LAST.
--
-- ORDER (production):
--   1. 20260731-2010-worker-prepared-sends-portal-kind.sql   — columns + CHECKs, kind NULLABLE
--   2. 20260731-2140-prepared-send-locale-is-a-choice.sql    — draft_locale drops 'unknown'
--   3. DEPLOY THE CODE                                        — every freeze now writes `kind`
--   4. THIS FILE                                              — kind becomes NOT NULL
--
-- WHY THE SPLIT (Bug-Hunter, 2026-07-31, caught before it shipped): the email freeze that is
-- live in production today does not write `kind`. Applying SET NOT NULL while that code is
-- running makes every Inbox email freeze fail a not-null check — and supabase-js RETURNS that
-- error instead of throwing, so the helper reports "❌ Couldn't prepare the email — please try
-- again" and nobody can send a worker email from ANY surface until the deploy lands. The
-- DDL-then-deploy habit is the normal order here, which is exactly why this had to be split.
--
-- Running this file before step 3 is safe in the sense that it will simply FAIL on any NULL
-- row — but the damage is the window it opens, not the statement itself. Do not run it early.
--
-- Idempotent: re-running against an already-NOT NULL column is a no-op.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM worker_prepared_sends WHERE kind IS NULL
  ) THEN
    RAISE EXCEPTION
      'worker_prepared_sends has rows with kind IS NULL — the code that writes kind is not deployed yet. Deploy first, then re-run this migration.';
  END IF;
END $$;

ALTER TABLE worker_prepared_sends ALTER COLUMN kind SET NOT NULL;
