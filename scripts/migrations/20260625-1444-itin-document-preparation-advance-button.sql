-- ITIN workspace fix (Issue 1): add an advance button to the "Document Preparation" stage.
--
-- The ITIN "Document Preparation" stage (stage_order 2) layout was
-- document_viewer + info_panel + chat with NO action_buttons, so staff could not
-- advance the SD from the workspace to "Client Signing" after reviewing the
-- auto-generated W-7 / 1040-NR / Schedule OI. Every other ITIN stage already
-- carries an `advance_next` action. This adds the same forward action here.
--
-- Idempotent: only appends when no action_buttons component is present yet, so
-- re-running is a no-op and the existing `description` is preserved.

UPDATE pipeline_stages
SET stage_layout = jsonb_set(
      stage_layout,
      '{components}',
      (stage_layout->'components') || '[{
        "type": "action_buttons",
        "actions": [
          {"key": "advance_next", "label": "Documents Reviewed — Send to Client", "target": "Client Signing"}
        ]
      }]'::jsonb
    )
WHERE service_type = 'ITIN'
  AND stage_name = 'Document Preparation'
  AND NOT (stage_layout->'components' @> '[{"type":"action_buttons"}]');
