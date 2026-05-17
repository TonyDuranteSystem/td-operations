-- Workflow System — Slice 9: SD-lifecycle multi-stage workflows
--
-- Adds 3 task_workflows catalog rows + uses new triggered_by source 'sd_created':
--   closure_progress         — 5-stage Company Closure lifecycle
--   formation_progress       — 6-stage Company Formation lifecycle (longest)
--   onboarding_progress      — 2-stage post-autonomous Client Onboarding cleanup
--
-- Pattern (mirrors banking_physical_progress from Slice 8 + extends):
--   Each workflow is ONE catalog row with multiple stage-advance actions.
--   Each action's visible_when.sd_stage gates when the button renders
--   in the TaskCard (Slice 9 new system feature) — Luca only sees buttons
--   relevant to the SD's current pipeline stage. Most actions reuse the
--   generic chain.advance_sd_stage handler with handler_params.target_stage;
--   service-specific handlers exist only where MCP tool wrapping is needed
--   (formation_confirm, ss4_create, mark_complete with downstream SD spawn).
--
-- Trigger: each row's triggered_by = { source: 'sd_created', filter: {
-- service_type: '<name>' } }. The createSD hook (lib/operations/service-
-- delivery.ts) calls the dispatcher after every SD insert; the dispatcher
-- spawns the matching workflow task with task_meta seeded from the new SD.
--
-- Adding a new SD-lifecycle workflow after this:
--   INSERT one task_workflows row with triggered_by.filter.service_type =
--   '<new>'. Zero code change. Zero risk to siblings.
--
-- Idempotent: ON CONFLICT (catalog_id, slug) DO UPDATE.

-- ─── closure_progress ────────────────────────────────────────────────────
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, status, metadata
) VALUES (
  'task_workflows',
  'closure_progress',
  'Company Closure — Lifecycle Progress',
  'active',
  '{
    "version": 1,
    "label_admin": "Company Closure — Lifecycle Progress",
    "icon": "Building2",
    "default_assignee": "Luca",
    "default_priority": "Normal",
    "permission": { "role_in": ["admin", "team"] },
    "task_meta_schema": "sd_progress_v1",
    "auto_topic": "Closure",
    "triggered_by": {
      "source": "sd_created",
      "filter": { "service_type": "Company Closure" }
    },
    "actions": [
      {
        "slug": "approve_data",
        "label_admin": "Approve Data → State Compliance Check",
        "icon": "CheckCircle2",
        "color": "green",
        "primary": true,
        "permission": { "role_in": ["admin", "team"] },
        "handler": "closure.approve_data",
        "visible_when": { "sd_stage": "Data Collection" },
        "confirm": { "summary": "Approve the closure submission data, save documents to Drive, and advance to State Compliance Check?" },
        "on_success_status": "In Progress",
        "on_success_meta": { "workflow_state": "Compliance Check" }
      },
      {
        "slug": "confirm_state_compliance",
        "label_admin": "Compliance Verified → State Dissolution Filing",
        "icon": "Gavel",
        "color": "blue",
        "permission": { "role_in": ["admin", "team"] },
        "handler": "chain.advance_sd_stage",
        "handler_params": { "target_stage": "State Dissolution Filing" },
        "visible_when": { "sd_stage": "State Compliance Check" },
        "confirm": { "summary": "Confirm state compliance verified and advance to State Dissolution Filing?" },
        "on_success_status": "In Progress",
        "on_success_meta": { "workflow_state": "Dissolution Filing" }
      },
      {
        "slug": "confirm_dissolution_filed",
        "label_admin": "Dissolution Filed → IRS Closure",
        "icon": "FileCheck",
        "color": "blue",
        "permission": { "role_in": ["admin", "team"] },
        "handler": "chain.advance_sd_stage",
        "handler_params": { "target_stage": "IRS Closure" },
        "visible_when": { "sd_stage": "State Dissolution Filing" },
        "confirm": { "summary": "Confirm dissolution filed with state and advance to IRS Closure?" },
        "on_success_status": "In Progress",
        "on_success_meta": { "workflow_state": "IRS Closure" }
      },
      {
        "slug": "confirm_irs_closure",
        "label_admin": "IRS Closure Complete → Closing",
        "icon": "FileCheck2",
        "color": "blue",
        "permission": { "role_in": ["admin", "team"] },
        "handler": "chain.advance_sd_stage",
        "handler_params": { "target_stage": "Closing" },
        "visible_when": { "sd_stage": "IRS Closure" },
        "confirm": { "summary": "Confirm IRS final filings complete and advance to Closing?" },
        "on_success_status": "In Progress",
        "on_success_meta": { "workflow_state": "Closing" }
      },
      {
        "slug": "mark_complete",
        "label_admin": "Mark Closure Complete",
        "icon": "CheckCircle2",
        "color": "green",
        "permission": { "role_in": ["admin", "team"] },
        "handler": "sd.mark_complete",
        "visible_when": { "sd_stage": "Closing" },
        "confirm": { "summary": "Close the service delivery and mark the company closure complete?" },
        "on_success_status": "Done",
        "on_success_meta": { "workflow_state": "Completed" }
      },
      {
        "slug": "needs_fix",
        "label_admin": "Blocked / Needs Info",
        "icon": "AlertCircle",
        "color": "amber",
        "handler": "task.flag_blocked",
        "permission": { "role_in": ["admin", "team"] },
        "requires_input": { "field": "note", "label": "What is the blocker?", "required": true },
        "on_success_status": "Waiting",
        "on_success_meta": { "workflow_state": "Blocked" }
      }
    ]
  }'::jsonb
)
ON CONFLICT (catalog_id, slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  status       = EXCLUDED.status,
  metadata     = EXCLUDED.metadata,
  updated_at   = now();

-- ─── formation_progress ──────────────────────────────────────────────────
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, status, metadata
) VALUES (
  'task_workflows',
  'formation_progress',
  'Company Formation — Lifecycle Progress',
  'active',
  '{
    "version": 1,
    "label_admin": "Company Formation — Lifecycle Progress",
    "icon": "Landmark",
    "default_assignee": "Luca",
    "default_priority": "High",
    "permission": { "role_in": ["admin", "team"] },
    "task_meta_schema": "sd_progress_v1",
    "auto_topic": "Formation",
    "sla": { "warn_hours": 72, "escalate_hours": 168, "escalate_to": "Antonio" },
    "triggered_by": {
      "source": "sd_created",
      "filter": { "service_type": "Company Formation" }
    },
    "actions": [
      {
        "slug": "verify_data_and_name",
        "label_admin": "Verify Data + LLC Name → State Filing",
        "icon": "ClipboardCheck",
        "color": "blue",
        "primary": true,
        "permission": { "role_in": ["admin", "team"] },
        "handler": "chain.advance_sd_stage",
        "handler_params": { "target_stage": "State Filing" },
        "visible_when": { "sd_stage": "Data Collection" },
        "confirm": { "summary": "Confirm wizard data verified and LLC name available, advance to State Filing?" },
        "on_success_status": "In Progress",
        "on_success_meta": { "workflow_state": "State Filing" }
      },
      {
        "slug": "confirm_state_filed",
        "label_admin": "Filed with State → EIN Application",
        "icon": "Building2",
        "color": "green",
        "permission": { "role_in": ["admin", "team"] },
        "handler": "chain.advance_sd_stage",
        "handler_params": { "target_stage": "EIN Application" },
        "visible_when": { "sd_stage": "State Filing" },
        "confirm": { "summary": "Confirm Articles filed with SOS. Advance to EIN Application. (Account is created automatically when Articles are uploaded to Drive — separate mechanism per the 2026-05 architecture.)" },
        "on_success_status": "In Progress",
        "on_success_meta": { "workflow_state": "EIN Application" }
      },
      {
        "slug": "mark_ss4_generated",
        "label_admin": "SS-4 Generated → Awaiting Client Signature",
        "icon": "FileSignature",
        "color": "blue",
        "permission": { "role_in": ["admin", "team"] },
        "handler": "task.waiting_with_optional_message",
        "visible_when": { "sd_stage": "EIN Application" },
        "requires_input": { "field": "client_message_en", "label": "Optional note to client (EN)", "optional": true },
        "confirm": { "summary": "Mark SS-4 generated. (Run ss4_create via MCP if not already done — workflow tracks the milestone here.)" },
        "on_success_status": "Waiting",
        "on_success_meta": { "workflow_state": "Awaiting SS-4 Signature" }
      },
      {
        "slug": "mark_ss4_faxed",
        "label_admin": "SS-4 Faxed to IRS → Awaiting EIN",
        "icon": "Send",
        "color": "blue",
        "permission": { "role_in": ["admin", "team"] },
        "handler": "chain.advance_sd_stage",
        "handler_params": { "target_stage": "EIN Submitted" },
        "visible_when": { "sd_stage": "EIN Application" },
        "confirm": { "summary": "Confirm SS-4 has been faxed to IRS, advance to EIN Submitted?" },
        "on_success_status": "In Progress",
        "on_success_meta": { "workflow_state": "Awaiting EIN from IRS" }
      },
      {
        "slug": "confirm_ein_received",
        "label_admin": "EIN Received → Post-Formation",
        "icon": "CheckCircle2",
        "color": "green",
        "permission": { "role_in": ["admin", "team"] },
        "handler": "formation.confirm_ein_received",
        "visible_when": { "sd_stage": "EIN Submitted" },
        "requires_input": { "field": "ein_number", "label": "EIN (XX-XXXXXXX)", "required": true },
        "confirm": { "summary": "Record EIN on the Account, upload EIN letter to portal, advance to Post-Formation + Banking?" },
        "on_success_status": "In Progress",
        "on_success_meta": { "workflow_state": "Post-Formation" }
      },
      {
        "slug": "confirm_oa_lease",
        "label_admin": "OA + Lease Signed → Closing",
        "icon": "FileCheck",
        "color": "blue",
        "permission": { "role_in": ["admin", "team"] },
        "handler": "chain.advance_sd_stage",
        "handler_params": { "target_stage": "Closing" },
        "visible_when": { "sd_stage": "Post-Formation + Banking" },
        "confirm": { "summary": "Confirm Operating Agreement + Lease are signed (and banking submitted if applicable), advance to Closing?" },
        "on_success_status": "In Progress",
        "on_success_meta": { "workflow_state": "Closing" }
      },
      {
        "slug": "mark_complete",
        "label_admin": "Mark Formation Complete",
        "icon": "PartyPopper",
        "color": "green",
        "permission": { "role_in": ["admin", "team"] },
        "handler": "sd.mark_complete",
        "handler_params": {
          "spawn_next_sds": ["State RA Renewal", "State Annual Report"],
          "send_review_request": true
        },
        "visible_when": { "sd_stage": "Closing" },
        "confirm": { "summary": "Close the Formation SD, auto-create RA Renewal SD + Annual Report SD, send client review request?" },
        "on_success_status": "Done",
        "on_success_meta": { "workflow_state": "Completed" }
      },
      {
        "slug": "needs_fix",
        "label_admin": "Blocked / Needs Info",
        "icon": "AlertCircle",
        "color": "amber",
        "handler": "task.flag_blocked",
        "permission": { "role_in": ["admin", "team"] },
        "requires_input": { "field": "note", "label": "What is the blocker?", "required": true },
        "on_success_status": "Waiting",
        "on_success_meta": { "workflow_state": "Blocked" }
      }
    ]
  }'::jsonb
)
ON CONFLICT (catalog_id, slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  status       = EXCLUDED.status,
  metadata     = EXCLUDED.metadata,
  updated_at   = now();

-- ─── onboarding_progress ─────────────────────────────────────────────────
-- The autonomous onboarding_setup job (lib/jobs/handlers/onboarding-setup.ts)
-- creates the SD at stage 2 "Review & CRM Setup" (Magic Button IS the review),
-- having already done all the heavy CRM lifting in Phase 1. This workflow only
-- governs the remaining manual staff bits — RA change on Harbor + closing.
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, status, metadata
) VALUES (
  'task_workflows',
  'onboarding_progress',
  'Client Onboarding — Post-Setup Progress',
  'active',
  '{
    "version": 1,
    "label_admin": "Client Onboarding — Post-Setup Progress",
    "icon": "UserCheck",
    "default_assignee": "Luca",
    "default_priority": "Normal",
    "permission": { "role_in": ["admin", "team"] },
    "task_meta_schema": "sd_progress_v1",
    "auto_topic": "Onboarding",
    "triggered_by": {
      "source": "sd_created",
      "filter": { "service_type": "Client Onboarding" }
    },
    "actions": [
      {
        "slug": "confirm_ra_done",
        "label_admin": "RA Change Done on Harbor → Post-Review",
        "icon": "ShieldCheck",
        "color": "blue",
        "primary": true,
        "permission": { "role_in": ["admin", "team"] },
        "handler": "chain.advance_sd_stage",
        "handler_params": { "target_stage": "Post-Review & Closing" },
        "visible_when": { "sd_stage": "Review & CRM Setup" },
        "confirm": { "summary": "Confirm RA provider change has been completed on Harbor Compliance, advance to Post-Review & Closing?" },
        "on_success_status": "In Progress",
        "on_success_meta": { "workflow_state": "Post-Review" }
      },
      {
        "slug": "mark_complete",
        "label_admin": "All Items Complete → Close Onboarding",
        "icon": "PartyPopper",
        "color": "green",
        "permission": { "role_in": ["admin", "team"] },
        "handler": "sd.mark_complete",
        "handler_params": {
          "spawn_next_sds": ["State RA Renewal", "State Annual Report"],
          "send_review_request": true
        },
        "visible_when": { "sd_stage": "Post-Review & Closing" },
        "confirm": { "summary": "Confirm OA + Lease + Banking + Tax all complete. Close onboarding SD, auto-create RA Renewal + Annual Report SDs, send review request?" },
        "on_success_status": "Done",
        "on_success_meta": { "workflow_state": "Completed" }
      },
      {
        "slug": "needs_fix",
        "label_admin": "Blocked / Needs Info",
        "icon": "AlertCircle",
        "color": "amber",
        "handler": "task.flag_blocked",
        "permission": { "role_in": ["admin", "team"] },
        "requires_input": { "field": "note", "label": "What is the blocker?", "required": true },
        "on_success_status": "Waiting",
        "on_success_meta": { "workflow_state": "Blocked" }
      }
    ]
  }'::jsonb
)
ON CONFLICT (catalog_id, slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  status       = EXCLUDED.status,
  metadata     = EXCLUDED.metadata,
  updated_at   = now();
