-- Workflow System — Slice 5.1: ITIN number-received action upgraded to a
-- multi-field form that stamps the ITIN on the contact's CRM record.
--
-- Before: the "ITIN number received" action just took an optional Drive file
-- ID and advanced to the next workflow. The actual ITIN number had to be
-- typed into the "Deliver ITIN to client" message manually, with no
-- traceability and no CRM record update.
--
-- After: the action opens a 3-field form (ITIN # + issue date + IRS letter
-- Drive URL), validates the ITIN, stamps contacts.itin_number + itin_issue_date
-- on the contact, parses the Drive URL into a file ID, carries everything
-- forward in task_meta so the next workflow's delivery message can reference
-- it. Powered by the new itin.confirm_number_received handler.
--
-- Idempotent: ON CONFLICT DO UPDATE replaces the action list cleanly.

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
              "label": "IRS letter — Drive URL (optional)",
              "type": "drive_url",
              "optional": true,
              "placeholder": "https://drive.google.com/file/d/...",
              "help": "Drop the IRS letter PDF in Drive first, then paste its share URL here. Stored in task_meta for the delivery step."
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

-- Also bump version so any in-flight tasks pinned at version 1 can be
-- distinguished from new tasks using the multi-field form.
UPDATE catalog_entries
SET
  metadata = jsonb_set(metadata, '{version}', '2'::jsonb),
  updated_at = now()
WHERE catalog_id = 'task_workflows' AND slug = 'itin_irs_processing';

COMMIT;
