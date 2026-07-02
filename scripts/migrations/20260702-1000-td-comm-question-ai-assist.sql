-- TD Communication — operator-editable "AI assist" toggle on brand-audit questions.
--
-- When ai_assist = true, the client brand-audit wizard renders the ✨ "Generate
-- with AI" button on that question's textarea (the button drafts text the client
-- can edit). Keeping this in the DB (not hardcoded in the mapper) matches the
-- DB-driven questions system: operators toggle it per question in the CRM
-- Questions editor with no deploy.
--
-- Default false. Backfilled true for every existing textarea so all free-text
-- questions get the button out of the box (Antonio's decision: "all 22 textareas").

ALTER TABLE td_comm_questions
  ADD COLUMN IF NOT EXISTS ai_assist boolean NOT NULL DEFAULT false;

UPDATE td_comm_questions
  SET ai_assist = true
  WHERE type = 'textarea' AND ai_assist = false;
