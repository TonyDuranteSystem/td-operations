-- Tax Return workspace, Part 2 item 6 (dev job 6f555c9f), 2026-11-07 — fax the signed return to the IRS FROM THE WORKSPACE.
-- DATA ONLY: one layout change on the "Signed" step. No schema change.
--
--  "Signed": the plain "Send Fax to IRS" link (fax_irs: download the file, open the Fax tool, type the number) is replaced by the return fax box
--  (return_fax_panel): this job's signed copy, the IRS return number pre-filled, a confirm window, one send per job; the job is FILED BY ITSELF when
--  Faxage confirms delivery (cron /api/cron/return-fax-confirm). For companies that are not single-member LLCs the box shows the old link instead.
--  The "File with IRS" button stays as the fallback (a return filed another way). "TR Completed" keeps its fax_irs link (older step, old jobs only).
--
-- ORDER OF SHIPPING: the CODE first (it knows the new component type), THEN this change. Applied before the code, the step would show an
-- "Unknown component type" box. The UPDATE only fires while the row is EXACTLY as the item-5 migration (20261106-2330) wrote it (idempotent; never
-- overwrites a later edit).
-- Undo: 20261107-0200-tax-return-signed-fax-box.UNDO.sql. Sandbox first; production only on Antonio's word.

UPDATE pipeline_stages
SET stage_layout = '{"components": [{"type": "esign_panel", "title": "Signed return", "readOnly": true, "rename": "Tax Return {year} - {company_name}", "helpText": "The client signed. Open it to see or download the signed copy (a copy is also filed in the company storage and shown to the client)."}, {"type": "return_fax_panel"}, {"type": "document_viewer"}, {"type": "action_buttons", "actions": [{"key": "file_with_irs", "label": "File with IRS", "target": "TR Filed", "confirm": "Mark this return as filed with the IRS? The client will see it as Filed and their tax banner will go away."}]}, {"type": "chat"}], "description": "The client signed the return. Fax it to the IRS from here; the job is filed by itself once the fax is delivered."}'::jsonb
WHERE service_type = 'Tax Return' AND stage_name = 'Signed'
  AND stage_layout = '{"components": [{"type": "esign_panel", "title": "Signed return", "readOnly": true, "rename": "Tax Return {year} - {company_name}", "helpText": "The client signed. Open it to see or download the signed copy (a copy is also filed in the company storage and shown to the client)."}, {"type": "document_viewer"}, {"type": "action_buttons", "actions": [{"key": "file_with_irs", "label": "File with IRS", "target": "TR Filed", "confirm": "Mark this return as filed with the IRS? The client will see it as Filed and their tax banner will go away."}]}, {"type": "fax_irs"}, {"type": "chat"}], "description": "The client signed the return. Fax it to the IRS, then mark it filed."}'::jsonb;
