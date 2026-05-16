-- Workflow System — Slice 5: rest of ITIN chain
--
-- Adds the four downstream workflow rows that follow itin_review:
--   itin_review              (Slice 4) — admin reviews + approves the package
--   itin_await_client_mailing (this)   — waiting for client to physically mail signed docs
--   itin_caa_certify_and_mail (this)   — Luca certifies passport + mails to IRS
--   itin_irs_processing       (this)   — waits for IRS to process (7–11 weeks); cron pings monthly
--   itin_number_received      (this)   — IRS responds with the ITIN number; we deliver to client
--
-- Then wires the full chain into the services.itin row's
-- metadata.workflow_chain.transitions. The dispatcher (this slice's refactor)
-- reads these transitions after every successful action and auto-spawns the
-- next workflow task or advances the SD stage — no per-service code.
--
-- All four new workflows reuse task_meta_schema='itin_review_v1' since the
-- payload shape is the same throughout the chain (same submission_id, same
-- attachments, same client info carried through).
--
-- Idempotent: re-running is a no-op (ON CONFLICT DO UPDATE on rows; the
-- services UPDATE merges with jsonb || so prior keys survive).

BEGIN;

-- 1. itin_await_client_mailing -------------------------------------------------
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, display_name_translations, description, status, tags, capabilities, metadata
) VALUES (
  'task_workflows',
  'itin_await_client_mailing',
  'Awaiting client to mail ITIN package',
  '{"it": "In attesa che il cliente spedisca il pacchetto ITIN"}'::jsonb,
  'Holding state after Approve & Send. Closes automatically when the client confirms shipping via /portal/itin-documents (I have mailed button) — fires itin.client_mailed → next step. Manual override: admin can mark as mailed if the client confirms via chat instead.',
  'active',
  '["workflow"]'::jsonb,
  '{}'::jsonb,
  $json${
    "version": 1,
    "label_admin": "Awaiting client mailing",
    "icon": "Mail",
    "default_assignee": "Luca",
    "default_priority": "Normal",
    "permission": { "role_in": ["admin", "team"] },
    "task_meta_schema": "itin_review_v1",
    "auto_topic": "ITIN",
    "sla": { "warn_hours": 168, "escalate_hours": 336, "escalate_to": "Antonio" },
    "actions": [
      {
        "slug": "client_mailed",
        "label_admin": "Mark client has mailed",
        "icon": "PackageCheck",
        "color": "green",
        "primary": true,
        "permission": { "role_in": ["admin", "team"] },
        "handler": "chain.spawn_next_workflow",
        "confirm": { "summary": "Confirm the client has mailed the signed package and advance to CAA Certify?" },
        "on_success_status": "Done",
        "on_success_meta": { "workflow_state": "Client mailed" }
      },
      {
        "slug": "remind_client",
        "label_admin": "Send reminder to client",
        "icon": "Bell",
        "permission": { "role_in": ["admin", "team"] },
        "handler": "chain.send_client_message",
        "requires_input": { "field": "body_en", "label": "Reminder message (EN)", "required": true },
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

-- 2. itin_caa_certify_and_mail -------------------------------------------------
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, display_name_translations, description, status, tags, capabilities, metadata
) VALUES (
  'task_workflows',
  'itin_caa_certify_and_mail',
  'CAA certify passport + mail to IRS',
  '{"it": "Certificazione CAA + invio all''IRS"}'::jsonb,
  'Luca receives the client''s mailed package, CAA-certifies the passport copy, assembles the full ITIN application, and mails it to the IRS via certified mail. Click Mailed to IRS to advance to itin_irs_processing.',
  'active',
  '["workflow"]'::jsonb,
  '{}'::jsonb,
  $json${
    "version": 1,
    "label_admin": "CAA certify + mail to IRS",
    "icon": "Stamp",
    "default_assignee": "Luca",
    "default_priority": "High",
    "permission": { "role_in": ["admin", "team"] },
    "task_meta_schema": "itin_review_v1",
    "auto_topic": "ITIN",
    "sla": { "warn_hours": 72, "escalate_hours": 168, "escalate_to": "Antonio" },
    "actions": [
      {
        "slug": "mailed_to_irs",
        "label_admin": "Mailed to IRS",
        "icon": "Send",
        "color": "green",
        "primary": true,
        "permission": { "role_in": ["admin", "team"] },
        "handler": "chain.spawn_next_workflow",
        "requires_input": { "field": "tracking_number", "label": "USPS / FedEx tracking number", "required": true },
        "confirm": { "summary": "Confirm the certified package has been mailed to the IRS and advance to IRS Processing?" },
        "on_success_status": "Done",
        "on_success_meta": { "workflow_state": "Mailed to IRS" }
      },
      {
        "slug": "needs_replacement",
        "label_admin": "Need replacement docs from client",
        "icon": "AlertCircle",
        "color": "amber",
        "permission": { "role_in": ["admin", "team"] },
        "handler": "task.flag_blocked",
        "requires_input": { "field": "note", "label": "What''s wrong / what''s needed", "required": true },
        "on_success_status": "Waiting",
        "on_success_meta": { "workflow_state": "Awaiting replacement docs from client" }
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

-- 3. itin_irs_processing -------------------------------------------------------
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, display_name_translations, description, status, tags, capabilities, metadata
) VALUES (
  'task_workflows',
  'itin_irs_processing',
  'Awaiting IRS processing',
  '{"it": "In attesa di elaborazione IRS"}'::jsonb,
  'IRS typically processes ITIN applications in 7–11 weeks. Cron /api/cron/itin-processing-check pings every 4 weeks for tasks open longer than 8 weeks (pings the client by portal message). When IRS sends back the ITIN number, click Number received to advance.',
  'active',
  '["workflow"]'::jsonb,
  '{}'::jsonb,
  $json${
    "version": 1,
    "label_admin": "Awaiting IRS processing",
    "icon": "Clock",
    "default_assignee": "Luca",
    "default_priority": "Normal",
    "permission": { "role_in": ["admin", "team"] },
    "task_meta_schema": "itin_review_v1",
    "auto_topic": "ITIN",
    "sla": { "warn_hours": 1344, "escalate_hours": 2016, "escalate_to": "Antonio" },
    "actions": [
      {
        "slug": "number_received",
        "label_admin": "ITIN number received",
        "icon": "CheckCircle2",
        "color": "green",
        "primary": true,
        "permission": { "role_in": ["admin", "team"] },
        "handler": "chain.spawn_next_workflow",
        "requires_input": { "field": "irs_letter_drive_file_id", "label": "Drive file ID of the IRS letter (optional)", "optional": true },
        "confirm": { "summary": "Advance to ITIN Number Received and prepare client delivery?" },
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

-- 4. itin_number_received ------------------------------------------------------
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, display_name_translations, description, status, tags, capabilities, metadata
) VALUES (
  'task_workflows',
  'itin_number_received',
  'Deliver ITIN number to client',
  '{"it": "Consegna numero ITIN al cliente"}'::jsonb,
  'IRS issued the ITIN. Operator types the number, clicks Send to client — system stamps it on the contact, posts a portal message + email with the official letter scan, and advances the SD to ITIN Approved (final stage).',
  'active',
  '["workflow"]'::jsonb,
  '{}'::jsonb,
  $json${
    "version": 1,
    "label_admin": "Deliver ITIN to client",
    "icon": "MailCheck",
    "default_assignee": "Luca",
    "default_priority": "High",
    "permission": { "role_in": ["admin", "team"] },
    "task_meta_schema": "itin_review_v1",
    "auto_topic": "ITIN",
    "sla": { "warn_hours": 48, "escalate_hours": 120, "escalate_to": "Antonio" },
    "actions": [
      {
        "slug": "send_to_client",
        "label_admin": "Send ITIN to client + close",
        "icon": "Send",
        "color": "green",
        "primary": true,
        "permission": { "role_in": ["admin", "team"] },
        "handler": "chain.send_client_message",
        "requires_input": { "field": "body_en", "label": "Delivery message (EN — include the ITIN number)", "required": true },
        "confirm": { "summary": "Send the ITIN delivery message and advance the SD to ITIN Approved?" },
        "on_success_status": "Done",
        "on_success_meta": { "workflow_state": "Delivered" }
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

-- 5. services.itin chain transitions -------------------------------------------
-- This is the architectural payoff: the entire ITIN chain is declarative data.
-- After Slice 5's dispatcher refactor lands, completing any action whose name
-- appears as a key under transitions[<workflow_slug>] auto-spawns the next
-- workflow OR advances the SD stage. New workflows = catalog edits, no code.
UPDATE catalog_entries
SET
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'workflow_chain', jsonb_build_object(
      'on_wizard_complete', jsonb_build_object('spawn_workflow', 'itin_review'),
      'transitions', jsonb_build_object(
        'itin_review', jsonb_build_object(
          'approve_send', jsonb_build_object('spawn_workflow', 'itin_await_client_mailing')
        ),
        'itin_await_client_mailing', jsonb_build_object(
          'client_mailed', jsonb_build_object(
            'spawn_workflow', 'itin_caa_certify_and_mail',
            'advance_sd_stage', 'Documents Received'
          )
        ),
        'itin_caa_certify_and_mail', jsonb_build_object(
          'mailed_to_irs', jsonb_build_object(
            'spawn_workflow', 'itin_irs_processing',
            'advance_sd_stage', 'Submitted to IRS'
          )
        ),
        'itin_irs_processing', jsonb_build_object(
          'number_received', jsonb_build_object('spawn_workflow', 'itin_number_received')
        ),
        'itin_number_received', jsonb_build_object(
          'send_to_client', jsonb_build_object('advance_sd_stage', 'ITIN Approved')
        )
      )
    )
  ),
  updated_at = now()
WHERE catalog_id = 'services' AND slug = 'itin';

COMMIT;
