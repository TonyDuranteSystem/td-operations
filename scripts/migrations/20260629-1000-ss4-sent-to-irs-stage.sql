-- Migration: Add "SS-4 Sent to IRS" stage (order 7) between "SS-4 Signed" (6)
-- and "EIN Received" (moved to order 8).
--
-- Problem: uploading the fax receipt at "SS-4 Signed" auto-advanced the SD to
-- "EIN Received", skipping the waiting period. The fix adds an intermediate
-- stage so the auto-advance lands at "SS-4 Sent to IRS" instead.
--
-- Workspace changes:
--   • "SS-4 Signed"      — removes the action_button "EIN Received" (upload
--                          auto-advance now handles progression to next stage);
--                          client_label updated from "SS-4 sent to IRS" to
--                          "SS-4 signed" (that label now belongs to the new stage)
--   • "SS-4 Sent to IRS" — new waiting stage; staff clicks "EIN Received"
--                          action button when the EIN letter arrives; client
--                          sees the fax date ("· Faxed Jun 29, 2026")
--   • "EIN Received"     — stage_order shifted 7 → 8 (no other change)

-- 1. Shift "EIN Received" to order 8
UPDATE pipeline_stages
SET stage_order = 8
WHERE service_type = 'Company Formation'
  AND stage_name   = 'EIN Received';

-- 2. Update "SS-4 Signed":
--    a) Fix client_label (was "SS-4 sent to IRS" — now belongs to the new stage)
--    b) Remove the action_buttons component (upload auto-advance owns progression)
UPDATE pipeline_stages
SET client_label    = 'SS-4 signed',
    client_label_it = 'SS-4 firmato',
    stage_layout = jsonb_set(
      stage_layout,
      '{components}',
      (
        SELECT jsonb_agg(comp)
        FROM jsonb_array_elements(stage_layout->'components') AS comp
        WHERE comp->>'type' <> 'action_buttons'
      )
    )
WHERE service_type = 'Company Formation'
  AND stage_name   = 'SS-4 Signed';

-- 3. Insert new "SS-4 Sent to IRS" stage at order 7
INSERT INTO pipeline_stages (
  service_type,
  stage_name,
  stage_order,
  stage_layout,
  client_label,
  client_label_it,
  created_at
)
VALUES (
  'Company Formation',
  'SS-4 Sent to IRS',
  7,
  '{
    "description": "SS-4 faxed to IRS. Waiting for EIN letter (CP 575).",
    "components": [
      {
        "type": "waiting_notice",
        "label": "The SS-4 has been faxed to the IRS. We are waiting for the EIN letter (CP 575). This typically takes 4-6 weeks."
      },
      {
        "type": "document_viewer"
      },
      {
        "type": "chat"
      },
      {
        "type": "action_buttons",
        "actions": [
          {
            "key": "advance_next",
            "label": "EIN Received",
            "target": "EIN Received"
          }
        ]
      }
    ]
  }'::jsonb,
  'SS-4 Faxed to IRS – Waiting for EIN',
  'SS-4 Inviato all''IRS – In attesa del Codice Fiscale',
  now()
);
