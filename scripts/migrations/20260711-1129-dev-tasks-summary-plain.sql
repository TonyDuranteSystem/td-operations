-- Dev-tracker board: add a plain-English summary layer (for Antonio) alongside
-- the technical detail (for coding sessions). Additive + nullable.
ALTER TABLE dev_tasks
  ADD COLUMN IF NOT EXISTS summary_plain text;
