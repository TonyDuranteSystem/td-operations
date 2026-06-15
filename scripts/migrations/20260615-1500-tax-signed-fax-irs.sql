-- Add the "Send Fax to IRS" component (fax_irs) to the Tax Return "Signed"
-- stage workspace, alongside the existing "File with IRS" action button.
--
-- Verified current layout (sandbox, 2026-06-15):
--   document_viewer + action_buttons[file_with_irs] + chat
-- New layout inserts fax_irs between the action buttons and the chat so the
-- fax CTA sits next to "File with IRS". Layout is read live per render
-- (pipeline_stages.stage_layout), so this takes effect immediately for all
-- Tax Return flows; in-flight SDs are not pinned to the old layout.

UPDATE pipeline_stages
SET stage_layout = '{
  "components": [
    { "type": "document_viewer" },
    { "type": "action_buttons", "actions": ["file_with_irs"] },
    { "type": "fax_irs" },
    { "type": "chat" }
  ],
  "description": "Client signed. Ready to file with IRS."
}'::jsonb
WHERE service_type = 'Tax Return'
  AND stage_name = 'Signed';
