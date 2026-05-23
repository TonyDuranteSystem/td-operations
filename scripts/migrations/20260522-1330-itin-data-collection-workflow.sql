-- ITIN-GAP-1: itin_data_collection workflow
--
-- When an ITIN service delivery is created (standalone purchase or bundled
-- in formation/onboarding), the admin SD card had no action buttons — staff
-- had no way to send the client the wizard link from the dashboard.
--
-- This migration adds the itin_data_collection workflow that auto-spawns on
-- sd_created (service_type=ITIN). It gives the admin one primary action:
-- "Send wizard link to client" — which fires chain.send_client_message with a
-- pre-baked bilingual message containing the portal wizard URL. No operator
-- input required; the action completes (Done) after sending.
--
-- A secondary "Remind client" action lets staff send a custom follow-up if the
-- client hasn't filled the wizard after a few days.
--
-- The message body uses handler_params (catalog pre-bake) so chain.send_client_message
-- sends without a modal. This relies on the handler_params merge added in
-- lib/tasks/workflow-handlers/chain-send-client-message.ts (same PR).
--
-- When the client completes the ITIN wizard, the existing itin_review workflow
-- spawns from the form_submission trigger — no change to that chain.
--
-- Idempotent: ON CONFLICT DO UPDATE.

BEGIN;

INSERT INTO catalog_entries (
  catalog_id, slug, display_name, display_name_translations, description, status, tags, capabilities, metadata
) VALUES (
  'task_workflows',
  'itin_data_collection',
  'Send ITIN wizard link to client',
  '{"it": "Invia il link del modulo ITIN al cliente"}'::jsonb,
  'Auto-spawned when an ITIN service delivery is created. Primary action sends the client a portal message with their wizard link (portal.tonydurante.us/portal/wizard). When the client completes the wizard, the itin_review chain takes over.',
  'active',
  '["workflow"]'::jsonb,
  '{}'::jsonb,
  $json${
    "version": 1,
    "label_admin": "Data Collection — Send wizard link",
    "icon": "Send",
    "default_assignee": "Luca",
    "default_priority": "High",
    "permission": { "role_in": ["admin", "team"] },
    "task_meta_schema": "sd_progress_v1",
    "auto_topic": "ITIN",
    "sla": { "warn_hours": 48, "escalate_hours": 120, "escalate_to": "Antonio" },
    "triggered_by": {
      "source": "sd_created",
      "filter": { "service_type": "ITIN" }
    },
    "task_title_template": "ITIN — {service_name}",
    "actions": [
      {
        "slug": "send_wizard_link",
        "label_admin": "Send wizard link to client",
        "icon": "Send",
        "color": "green",
        "primary": true,
        "permission": { "role_in": ["admin", "team"] },
        "handler": "chain.send_client_message",
        "handler_params": {
          "body_en": "Hi! Your ITIN application has been activated. Please log into your client portal and complete the ITIN questionnaire — it takes about 10 minutes:\n\nhttps://portal.tonydurante.us/portal/wizard\n\nWe need this information to prepare your W-7 and 1040-NR forms. Once you submit the form, we will review everything and send you the documents to sign.\n\nIf you have any questions, reply to this message.",
          "body_it": "Ciao! La tua pratica ITIN è stata attivata. Accedi al tuo portale cliente e compila il questionario ITIN — ci vogliono circa 10 minuti:\n\nhttps://portal.tonydurante.us/portal/wizard\n\nAbbiamo bisogno di queste informazioni per preparare i moduli W-7 e 1040-NR. Una volta inviato il modulo, lo revisueremo e ti invieremo i documenti da firmare.\n\nSe hai domande, rispondi a questo messaggio.",
          "topic": "ITIN"
        },
        "confirm": { "summary": "Send the ITIN wizard link to the client via portal message?" },
        "on_success_status": "Done",
        "on_success_meta": { "workflow_state": "Wizard link sent" }
      },
      {
        "slug": "remind_client",
        "label_admin": "Send reminder",
        "icon": "Bell",
        "permission": { "role_in": ["admin", "team"] },
        "handler": "chain.send_client_message",
        "requires_input": { "field": "body_en", "label": "Reminder message (EN)", "required": true },
        "handler_params": { "topic": "ITIN" },
        "on_success_status": "Waiting",
        "on_success_meta": { "workflow_state": "Reminder sent" }
      },
      {
        "slug": "cancel",
        "label_admin": "Cancel ITIN",
        "icon": "X",
        "color": "red",
        "permission": { "role_in": ["admin"] },
        "handler": "task.cancel",
        "requires_input": { "field": "reason", "label": "Cancellation reason", "required": true },
        "on_success_status": "Cancelled",
        "on_success_meta": { "workflow_state": "Cancelled" }
      }
    ]
  }$json$::jsonb
)
ON CONFLICT (catalog_id, slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  display_name_translations = EXCLUDED.display_name_translations,
  description = EXCLUDED.description,
  status = EXCLUDED.status,
  tags = EXCLUDED.tags,
  metadata = EXCLUDED.metadata,
  updated_at = now();

COMMIT;
