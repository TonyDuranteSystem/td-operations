-- UNDO for 20261018-1830-kb-sop-retire-handoff-and-drive-tools.sql : puts back the exact original text of every row it touched.
-- One statement. Expected report: sop 8, kb 5.
WITH s AS (
  UPDATE sop_runbooks r SET content = b.content, updated_at = now()
  FROM retired_handoff_text_backup b WHERE b.tbl = 'sop' AND b.id = r.id
  RETURNING r.id
), k AS (
  UPDATE knowledge_articles a SET content = b.content, updated_at = now()
  FROM retired_handoff_text_backup b WHERE b.tbl = 'kb' AND b.id = a.id
  RETURNING a.id
)
SELECT (SELECT count(*) FROM s) AS sop_rows_restored, (SELECT count(*) FROM k) AS kb_rows_restored;
-- The backup table is kept on purpose (drop it by hand once you are sure): DROP TABLE retired_handoff_text_backup;
