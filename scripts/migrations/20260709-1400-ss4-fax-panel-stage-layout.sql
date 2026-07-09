-- Company Formation "SS-4 Signed" stage: swap the passive `fax_irs` link for the
-- new in-workspace `ss4_fax_panel` (View + one-click fax of the combined
-- signed-SS-4 + Articles package). All other components (document_viewer,
-- document_upload "Upload fax confirmation/tracking", chat) are unchanged.
--
-- DML on a protected table (pipeline_stages). Apply to sandbox first, then to
-- production only on Antonio's explicit approval.
UPDATE pipeline_stages
SET stage_layout = jsonb_set(
  stage_layout,
  '{components}',
  '[
    {"type": "document_viewer"},
    {"type": "ss4_fax_panel"},
    {"type": "document_upload", "label": "Upload fax confirmation/tracking"},
    {"type": "chat"}
  ]'::jsonb
)
WHERE service_type = 'Company Formation'
  AND stage_name = 'SS-4 Signed';
