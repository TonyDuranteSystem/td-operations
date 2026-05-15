-- Workflow System — Slice 4: ITIN review workflow catalog seed
--
-- Inserts the itin_review row into catalog_entries (catalog_id='task_workflows')
-- and updates the services.itin row's metadata.workflow_chain to point at it.
--
-- See sysdocs:
--   'workflows-system-master-plan'
--   'ops-2026-05-15-workflow-system-slice-0-audit'
-- Dev task e364e980-8474-4410-8a6c-08f7e24a675d.
--
-- Idempotent: re-running against an environment where these are already set
-- is a no-op (catalog_entries uses ON CONFLICT DO UPDATE; services row uses
-- jsonb_set so other metadata keys are preserved).

BEGIN;

-- 1. itin_review workflow row -------------------------------------------------
-- Per Slice 0 audit Decision A (no Blocked enum), on_success_status for the
-- needs_fix and waiting_client actions is 'Waiting'; the fine-grained state
-- ('Needs Fix' / 'Waiting on Client') lives in on_success_meta.workflow_state.
-- Per Decision B, default permissions allow both admin and team to act;
-- tighten in the /catalog UI later if desired without touching code.
INSERT INTO catalog_entries (
  catalog_id,
  slug,
  display_name,
  display_name_translations,
  description,
  description_translations,
  status,
  tags,
  capabilities,
  metadata
) VALUES (
  'task_workflows',
  'itin_review',
  'Review ITIN forms',
  '{"it": "Revisione moduli ITIN"}'::jsonb,
  'Admin review of auto-generated W-7, 1040-NR, and Schedule OI PDFs. Approve sends the package to the client for wet-ink signature and mailing; Needs Fix flags blockers; Waiting on Client puts the task in a holding state.',
  '{"it": "Revisione amministrativa dei PDF W-7, 1040-NR e Schedule OI generati automaticamente. Approva invia il pacchetto al cliente per firma e spedizione; Needs Fix segnala blocchi; Waiting on Client mette in attesa."}'::jsonb,
  'active',
  '["workflow"]'::jsonb,
  '{}'::jsonb,
  $json${
    "version": 1,
    "label_admin": "Review ITIN forms",
    "icon": "FileSignature",
    "default_assignee": "Luca",
    "default_priority": "High",
    "permission": { "role_in": ["admin", "team"] },
    "attachment_template": "pdf_list",
    "task_meta_schema": "itin_review_v1",
    "auto_topic": "ITIN",
    "sla": { "warn_hours": 24, "escalate_hours": 72, "escalate_to": "Antonio" },
    "actions": [
      {
        "slug": "approve_send",
        "label_admin": "Approve & Send to Client",
        "icon": "CheckCircle2",
        "color": "green",
        "primary": true,
        "permission": { "role_in": ["admin", "team"] },
        "handler": "itin.approve_and_send",
        "confirm": {
          "preview_template": "itin_approve_preview",
          "summary": "Send the W-7, 1040-NR, and Schedule OI to the client and advance the SD to Client Signing?"
        },
        "on_success_status": "Done"
      },
      {
        "slug": "needs_fix",
        "label_admin": "Needs Fix",
        "icon": "AlertCircle",
        "color": "amber",
        "permission": { "role_in": ["admin", "team"] },
        "handler": "task.flag_blocked",
        "requires_input": { "field": "note", "label": "What needs fixing?", "required": true },
        "on_success_status": "Waiting",
        "on_success_meta": { "workflow_state": "Needs Fix" }
      },
      {
        "slug": "waiting_client",
        "label_admin": "Waiting on Client",
        "icon": "Hourglass",
        "color": "zinc",
        "permission": { "role_in": ["admin", "team"] },
        "handler": "task.waiting_with_optional_message",
        "requires_input": { "field": "client_message_en", "label": "Optional message to client (EN)", "optional": true },
        "on_success_status": "Waiting",
        "on_success_meta": { "workflow_state": "Waiting on Client" }
      },
      {
        "slug": "recall",
        "label_admin": "Recall & Re-correct",
        "icon": "RotateCcw",
        "color": "red",
        "permission": { "role_in": ["admin", "team"] },
        "handler": "itin.recall_and_recorrect",
        "requires_input": { "field": "reason", "label": "Recall reason", "optional": true },
        "confirm": {
          "summary": "Hide the sent documents, revert the SD, and spawn a fresh review task? The email itself cannot be unsent."
        },
        "on_success_status": "Cancelled",
        "on_success_meta": { "workflow_state": "Recalled" }
      }
    ]
  }$json$::jsonb
)
ON CONFLICT (catalog_id, slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  display_name_translations = EXCLUDED.display_name_translations,
  description = EXCLUDED.description,
  description_translations = EXCLUDED.description_translations,
  status = EXCLUDED.status,
  tags = EXCLUDED.tags,
  metadata = EXCLUDED.metadata,
  updated_at = now();

-- 2. services.itin row gains a minimal workflow_chain -------------------------
-- Slice 4 wires only the entry point (auto-chain Step 6 reads this to decide
-- which task_workflows row to spawn). Slice 5 will add the full transitions
-- (itin_review → itin_await_client_mailing → itin_caa_certify_and_mail → ...).
UPDATE catalog_entries
SET
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'workflow_chain', jsonb_build_object(
      'on_wizard_complete', jsonb_build_object('spawn_workflow', 'itin_review')
    )
  ),
  updated_at = now()
WHERE catalog_id = 'services' AND slug = 'itin';

COMMIT;
