-- Dev-tracker board (Phase 1): add channel tag, findings, approved plan, and a
-- non-linear milestone ladder to dev_tasks. All additive + nullable.
-- Readers (config page, exceptions flow, MCP tools) select explicit columns,
-- so new fields are ignored by existing code — no reader breaks.
--
-- Design notes (supervisor refinements folded in):
--  * channel        : board slug, validated APP-SIDE against the real internal_threads
--                     channel list (td-dev|td-bug|td-support|td-taxreturn) so the tag
--                     can never drift from the actual channels. No FK (channels are a
--                     separate concept; validation lives in the tools/UI).
--  * milestones     : non-linear ladder. { "current": "<stage>",
--                     "history": [ { "stage": "...", "at": "<iso>", "by": "...", "note": "..." } ] }
--                     A stage can move BACKWARD (QA fail -> Building; new bug -> Investigated).
--  * lane derivation: the board lane stays the existing `status` column, but the
--                     milestone-advance tool is the single writer that keeps `status`
--                     in lockstep with `current` — one knob, no drift.

ALTER TABLE dev_tasks
  ADD COLUMN IF NOT EXISTS channel    text,
  ADD COLUMN IF NOT EXISTS findings   text,
  ADD COLUMN IF NOT EXISTS plan       text,
  ADD COLUMN IF NOT EXISTS milestones jsonb;

-- Backfill channel so every existing job lands on the board.
UPDATE dev_tasks
   SET channel = CASE WHEN type = 'bugfix' THEN 'td-bug' ELSE 'td-dev' END
 WHERE channel IS NULL;
