-- Workflow System — Slice 5.2: replace IRS letter URL paste with real file upload
--
-- Before (Slice 5.1): the IRS letter field on the "ITIN number received"
-- action was type='drive_url' — operator dropped letter in Drive then pasted
-- the share URL. Antonio's feedback: pasting Drive URLs doesn't make sense
-- when we could just upload the file from the modal into the right place.
--
-- After: field type='file'. Modal renders a real file picker. On select,
-- the file uploads via POST /api/workflows/upload-task-file → Drive (under
-- the account's drive_folder_id, in subfolder 'ITIN/IRS Letters'). The
-- resulting Drive file_id is stored in task_meta.irs_letter_file_id.
--
-- handler_params/upload_subfolder declares where in Drive the file lands.
-- For ITIN: '<account drive folder>/ITIN/IRS Letters'.
--
-- Idempotent.

BEGIN;

UPDATE catalog_entries
SET
  metadata = jsonb_set(
    metadata,
    '{actions}',
    $json$[
      {
        "slug": "number_received",
        "label_admin": "ITIN number received",
        "icon": "CheckCircle2",
        "color": "green",
        "primary": true,
        "permission": { "role_in": ["admin", "team"] },
        "handler": "itin.confirm_number_received",
        "requires_input": {
          "fields": [
            {
              "field": "itin_number",
              "label": "ITIN number",
              "type": "itin_number",
              "required": true,
              "placeholder": "9XX-XX-XXXX",
              "help": "9 digits starting with 9. Dashes optional — they'll be stripped before validation."
            },
            {
              "field": "itin_issue_date",
              "label": "IRS issue date",
              "type": "date",
              "optional": true,
              "help": "Defaults to today if left blank."
            },
            {
              "field": "irs_letter_drive_url",
              "label": "IRS letter (PDF)",
              "type": "file",
              "optional": true,
              "accept": "application/pdf,image/*",
              "upload_subfolder": "ITIN/IRS Letters",
              "help": "Click Choose File to upload the IRS letter directly to the client's Drive folder. Filed under ITIN/IRS Letters/."
            }
          ]
        },
        "confirm": { "summary": "Stamp the ITIN on the contact's CRM record and advance to the delivery step?" },
        "on_success_status": "Done",
        "on_success_meta": { "workflow_state": "ITIN number received" }
      },
      {
        "slug": "ping_client",
        "label_admin": "Send IRS-pending reminder to client",
        "icon": "Bell",
        "permission": { "role_in": ["admin", "team"] },
        "handler": "chain.send_client_message",
        "requires_input": { "field": "body_en", "label": "Update message (EN)", "required": true },
        "on_success_status": "Waiting",
        "on_success_meta": { "workflow_state": "Client pinged" }
      },
      {
        "slug": "irs_rejected",
        "label_admin": "IRS rejected — needs rework",
        "icon": "AlertCircle",
        "color": "red",
        "permission": { "role_in": ["admin", "team"] },
        "handler": "task.flag_blocked",
        "requires_input": { "field": "note", "label": "IRS rejection reason / next steps", "required": true },
        "on_success_status": "Waiting",
        "on_success_meta": { "workflow_state": "IRS rejected" }
      }
    ]$json$::jsonb,
    true
  ),
  updated_at = now()
WHERE catalog_id = 'task_workflows' AND slug = 'itin_irs_processing';

UPDATE catalog_entries
SET
  metadata = jsonb_set(metadata, '{version}', '3'::jsonb),
  updated_at = now()
WHERE catalog_id = 'task_workflows' AND slug = 'itin_irs_processing';

COMMIT;
