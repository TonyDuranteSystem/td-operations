-- Flow Workspace stage-layout updates (feature/flow-workspaces).
--
-- Three component types went from placeholder stubs to real components:
--   document_viewer, external_link (state-aware), action_buttons (complete).
-- This migration updates the stage_layout JSONB for State Annual Report and
-- State RA Renewal stages to wire them in:
--
--   1. AR "Due Date" (10): add an external_link to the Secretary of State portal
--      (no url → the component resolves it from the account's state_of_formation).
--   2. AR "Filed" (20) + "Filing Receipt Uploaded" (30): add action_buttons
--      ["complete"] — a "Mark as Completed" button that advances to "Closed".
--      Both stages carry it because the single receipt upload auto-advances the
--      SD to order 20, while order 30 is the stage named in the spec; placing it
--      on both keeps the complete action reachable wherever the SD rests.
--   3. RA "Renewal Processed" (20) + "Document Uploaded" (30): same complete
--      button. The RA "Renewal Due" (10) stage already has a literal Harbor
--      Compliance external_link — left unchanged.
--
-- Idempotent: each UPDATE sets the full layout, so re-running is a no-op.

-- 1. State Annual Report — Due Date (order 10): + external_link (SoS).
UPDATE pipeline_stages
SET stage_layout = '{
  "components": [
    {"type": "info_panel"},
    {"type": "external_link", "label": "File on Secretary of State Portal"},
    {"type": "document_upload", "label": "Upload Filing Receipt", "required": true},
    {"type": "chat"}
  ],
  "description": "File the annual report on the state portal and upload the receipt."
}'::jsonb
WHERE service_type = 'State Annual Report' AND stage_name = 'Due Date';

-- 2a. State Annual Report — Filed (order 20): + action_buttons complete.
UPDATE pipeline_stages
SET stage_layout = '{
  "components": [
    {"type": "document_viewer"},
    {"type": "info_panel"},
    {"type": "action_buttons", "actions": ["complete"]}
  ],
  "description": "Annual report filed. Receipt uploaded."
}'::jsonb
WHERE service_type = 'State Annual Report' AND stage_name = 'Filed';

-- 2b. State Annual Report — Filing Receipt Uploaded (order 30): + action_buttons.
UPDATE pipeline_stages
SET stage_layout = '{
  "components": [
    {"type": "document_viewer"},
    {"type": "action_buttons", "actions": ["complete"]}
  ],
  "description": "Filing receipt uploaded."
}'::jsonb
WHERE service_type = 'State Annual Report' AND stage_name = 'Filing Receipt Uploaded';

-- 3a. State RA Renewal — Renewal Processed (order 20): + action_buttons complete.
UPDATE pipeline_stages
SET stage_layout = '{
  "components": [
    {"type": "document_viewer"},
    {"type": "info_panel"},
    {"type": "action_buttons", "actions": ["complete"]}
  ],
  "description": "Renewal processed. Receipt uploaded."
}'::jsonb
WHERE service_type = 'State RA Renewal' AND stage_name = 'Renewal Processed';

-- 3b. State RA Renewal — Document Uploaded (order 30): + action_buttons complete.
UPDATE pipeline_stages
SET stage_layout = '{
  "components": [
    {"type": "document_viewer"},
    {"type": "action_buttons", "actions": ["complete"]}
  ],
  "description": "RA renewal receipt uploaded."
}'::jsonb
WHERE service_type = 'State RA Renewal' AND stage_name = 'Document Uploaded';
