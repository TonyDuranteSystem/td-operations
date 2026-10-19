-- UNDO for 20261018-1830-kb-sop-retire-handoff-and-drive-tools.sql : puts back the exact original text of every row it touched,
-- from the JSON backup kept in the system doc ops-2026-10-18-kb-sop-handoff-backup. One statement. Expected report: sop 8, kb 5.
WITH bk AS (
  SELECT e FROM jsonb_array_elements((SELECT content::jsonb FROM system_docs WHERE slug = 'ops-2026-10-18-kb-sop-handoff-backup')) AS e
), s AS (
  UPDATE sop_runbooks r SET content = bk.e->>'content', updated_at = now()
  FROM bk WHERE bk.e->>'tbl' = 'sop' AND (bk.e->>'id')::uuid = r.id
  RETURNING r.id
), k AS (
  UPDATE knowledge_articles a SET content = bk.e->>'content', updated_at = now()
  FROM bk WHERE bk.e->>'tbl' = 'kb' AND (bk.e->>'id')::uuid = a.id
  RETURNING a.id
)
SELECT (SELECT count(*) FROM s) AS sop_rows_restored, (SELECT count(*) FROM k) AS kb_rows_restored;
-- The backup doc is kept on purpose (delete it by hand once you are sure).
