-- Dev-tracker: knowledge-capture pointer.
-- When a dev job is finished it should point to WHERE its lasting knowledge was
-- written down (a living system doc, a KB article, a sysdoc), so folding the
-- card away never loses what it taught. The board POINTS to the doc — it never
-- duplicates it (the docs/KB stay the single source of truth).
--   knowledge_ref    : free-text pointer (e.g. "sysdoc: dev-tracker", a KB id, a
--                      docs/systems path, or a URL). NULL = not captured yet.
--   knowledge_status : 'captured' (pointer recorded) | 'chore' (nothing worth
--                      documenting) | NULL (undecided). Soft — a nudge, not a wall.

ALTER TABLE dev_tasks
  ADD COLUMN IF NOT EXISTS knowledge_ref text,
  ADD COLUMN IF NOT EXISTS knowledge_status text;

ALTER TABLE dev_tasks
  DROP CONSTRAINT IF EXISTS dev_tasks_knowledge_status_check;

ALTER TABLE dev_tasks
  ADD CONSTRAINT dev_tasks_knowledge_status_check
  CHECK (knowledge_status IS NULL OR knowledge_status IN ('captured', 'chore'));
