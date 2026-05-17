-- Workflow System — Slice 8 Pass 6: catalog-driven workflow dispatch
--
-- Architectural shift: workflow triggering moves from ROUTE CODE to CATALOG
-- DATA. Each task_workflows row that should auto-spawn from an event carries
-- a `triggered_by` predicate in its metadata. Auto-chain routes consult a
-- generic dispatcher (lib/tasks/dispatch-workflow-for-event.ts) that scans
-- task_workflows for matching triggers — no hardcoded slug per route.
--
-- What this migration does:
--   1. Rewrites banking_review_payset + banking_review_relay catalog rows to:
--      - Use ONE shared handler `banking.approve_form` (provider-specific
--        copy now lives in handler_params.followup_task, not handler code)
--      - Carry triggered_by predicate matching banking_submissions rows by provider
--   2. Adds triggered_by to tax_form_review (no provider filter — matches all
--      completed tax_return_submissions)
--   3. Adds triggered_by to itin_review (retrofit — unifies dispatch pattern)
--   4. Notes that banking_physical_progress intentionally has NO triggered_by
--      (manual spawn only in Slice 8; auto-spawn from SD creation is Slice 9+)
--
-- After this migration:
--   - Adding a 3rd banking provider (e.g. Mercury) = 1 SQL row insert with
--     triggered_by.filter.provider = 'mercury' and its own handler_params.
--     Zero code change. Zero risk to payset/relay (independent rows).
--   - Adding a new service-with-form = 1 new route (form-specific side
--     effects) + 1 SQL row. Existing services untouched.
--   - Changing follow-up task copy for an existing variant = 1 SQL update
--     to handler_params.followup_task.{title,description}_template. No deploy.
--
-- Idempotent: ON CONFLICT (catalog_id, slug) DO UPDATE rewrites metadata.

-- ─── banking_review_payset ─────────────────────────────────────────────────
-- Handler is now banking.approve_form (shared). Per-provider follow-up task
-- spec lives in handler_params.followup_task. triggered_by predicates the row
-- to banking_submissions WHERE provider='payset'.
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, status, metadata
) VALUES (
  'task_workflows',
  'banking_review_payset',
  'Review Payset Application',
  'active',
  '{
    "version": 1,
    "label_admin": "Review Payset Application",
    "icon": "Building2",
    "default_assignee": "Luca",
    "default_priority": "High",
    "permission": { "role_in": ["admin", "team"] },
    "task_meta_schema": "banking_review_v1",
    "auto_topic": "Banking",
    "sla": { "warn_hours": 48, "escalate_hours": 96, "escalate_to": "Antonio" },
    "triggered_by": {
      "source": "form_submission",
      "table": "banking_submissions",
      "filter": { "provider": "payset" }
    },
    "actions": [
      {
        "slug": "approve_and_apply",
        "label_admin": "Approve & Apply",
        "icon": "CheckCircle2",
        "color": "green",
        "primary": true,
        "permission": { "role_in": ["admin", "team"] },
        "handler": "banking.approve_form",
        "handler_params": {
          "followup_task": {
            "title_template": "Schedule Payset application session — {company_name}",
            "description_template": "Banking Payset form for {company_name} has been reviewed and applied.\n\nNext: Schedule a live session with the client (WhatsApp/Telegram) to complete the Payset application together — OTP verification is required.\n\nReference: banking_submissions token {token}",
            "assignee": "Luca",
            "priority": "High",
            "category": "Banking"
          }
        },
        "confirm": {
          "summary": "Apply Payset form data to CRM, mark submission reviewed, and create the follow-up scheduling task?"
        },
        "on_success_status": "Done"
      },
      {
        "slug": "needs_fix",
        "label_admin": "Needs Fix",
        "icon": "AlertCircle",
        "color": "amber",
        "handler": "task.flag_blocked",
        "permission": { "role_in": ["admin", "team"] },
        "requires_input": { "field": "note", "label": "What needs fixing?", "required": true },
        "on_success_status": "Waiting",
        "on_success_meta": { "workflow_state": "Needs Fix" }
      },
      {
        "slug": "waiting_client",
        "label_admin": "Waiting on Client",
        "icon": "Hourglass",
        "color": "zinc",
        "handler": "task.waiting_with_optional_message",
        "permission": { "role_in": ["admin", "team"] },
        "requires_input": { "field": "client_message_en", "label": "Optional message to client (EN)", "optional": true },
        "on_success_status": "Waiting",
        "on_success_meta": { "workflow_state": "Waiting on Client" }
      }
    ]
  }'::jsonb
)
ON CONFLICT (catalog_id, slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  status       = EXCLUDED.status,
  metadata     = EXCLUDED.metadata,
  updated_at   = now();

-- ─── banking_review_relay ──────────────────────────────────────────────────
-- Same handler (banking.approve_form), different copy in handler_params, and
-- triggered_by.filter.provider='relay'. Adding banking_review_mercury later
-- = same pattern, third row, zero code change.
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, status, metadata
) VALUES (
  'task_workflows',
  'banking_review_relay',
  'Review Relay Application',
  'active',
  '{
    "version": 1,
    "label_admin": "Review Relay Application",
    "icon": "Building2",
    "default_assignee": "Luca",
    "default_priority": "High",
    "permission": { "role_in": ["admin", "team"] },
    "task_meta_schema": "banking_review_v1",
    "auto_topic": "Banking",
    "sla": { "warn_hours": 48, "escalate_hours": 96, "escalate_to": "Antonio" },
    "triggered_by": {
      "source": "form_submission",
      "table": "banking_submissions",
      "filter": { "provider": "relay" }
    },
    "actions": [
      {
        "slug": "approve_and_apply",
        "label_admin": "Approve & Apply",
        "icon": "CheckCircle2",
        "color": "green",
        "primary": true,
        "permission": { "role_in": ["admin", "team"] },
        "handler": "banking.approve_form",
        "handler_params": {
          "followup_task": {
            "title_template": "Submit Relay USD application — {company_name}",
            "description_template": "Banking Relay form for {company_name} has been reviewed and applied.\n\nNext: Submit the application via the Relay dashboard using the collected data.\n\nReference: banking_submissions token {token}",
            "assignee": "Antonio",
            "priority": "High",
            "category": "Banking"
          }
        },
        "confirm": {
          "summary": "Apply Relay form data to CRM, mark submission reviewed, and create the follow-up submission task?"
        },
        "on_success_status": "Done"
      },
      {
        "slug": "needs_fix",
        "label_admin": "Needs Fix",
        "icon": "AlertCircle",
        "color": "amber",
        "handler": "task.flag_blocked",
        "permission": { "role_in": ["admin", "team"] },
        "requires_input": { "field": "note", "label": "What needs fixing?", "required": true },
        "on_success_status": "Waiting",
        "on_success_meta": { "workflow_state": "Needs Fix" }
      },
      {
        "slug": "waiting_client",
        "label_admin": "Waiting on Client",
        "icon": "Hourglass",
        "color": "zinc",
        "handler": "task.waiting_with_optional_message",
        "permission": { "role_in": ["admin", "team"] },
        "requires_input": { "field": "client_message_en", "label": "Optional message to client (EN)", "optional": true },
        "on_success_status": "Waiting",
        "on_success_meta": { "workflow_state": "Waiting on Client" }
      }
    ]
  }'::jsonb
)
ON CONFLICT (catalog_id, slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  status       = EXCLUDED.status,
  metadata     = EXCLUDED.metadata,
  updated_at   = now();

-- ─── banking_physical_progress ────────────────────────────────────────────
-- INTENTIONALLY NO triggered_by — this workflow is spawned MANUALLY by admin
-- via the CRM (admin sets delivery_id to the Banking Physical SD). Auto-spawn
-- from SD creation is Slice 9+ scope. Row metadata otherwise unchanged from
-- pass 2 (3 stage-advance actions via generic chain.advance_sd_stage).
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, status, metadata
) VALUES (
  'task_workflows',
  'banking_physical_progress',
  'Banking Physical — Stage Progress',
  'active',
  '{
    "version": 1,
    "label_admin": "Banking Physical — Stage Progress",
    "icon": "Landmark",
    "default_assignee": "Luca",
    "default_priority": "Normal",
    "permission": { "role_in": ["admin", "team"] },
    "task_meta_schema": "banking_physical_v1",
    "auto_topic": "Banking",
    "actions": [
      {
        "slug": "confirm_scheduling_done",
        "label_admin": "Scheduling Done → Application Prepared",
        "icon": "Calendar",
        "color": "blue",
        "handler": "chain.advance_sd_stage",
        "handler_params": { "target_stage": "Application Prepared" },
        "permission": { "role_in": ["admin", "team"] },
        "confirm": { "summary": "Advance service delivery from Scheduling to Application Prepared?" }
      },
      {
        "slug": "confirm_docs_received",
        "label_admin": "Documents Received → Bank Visit",
        "icon": "FileCheck",
        "color": "blue",
        "handler": "chain.advance_sd_stage",
        "handler_params": { "target_stage": "Bank Visit" },
        "permission": { "role_in": ["admin", "team"] },
        "confirm": { "summary": "Confirm company + individual documents received. Advance to Bank Visit?" }
      },
      {
        "slug": "confirm_visit_done",
        "label_admin": "Visit Done → Account Opened",
        "icon": "CheckCircle2",
        "color": "green",
        "handler": "chain.advance_sd_stage",
        "handler_params": { "target_stage": "Account Opened" },
        "permission": { "role_in": ["admin", "team"] },
        "confirm": { "summary": "Confirm bank visit completed and physical account opened?" },
        "on_success_status": "Done"
      },
      {
        "slug": "needs_fix",
        "label_admin": "Issue / Blocked",
        "icon": "AlertCircle",
        "color": "amber",
        "handler": "task.flag_blocked",
        "permission": { "role_in": ["admin", "team"] },
        "requires_input": { "field": "note", "label": "What is the issue?", "required": true },
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

-- ─── tax_form_review ──────────────────────────────────────────────────────
-- Triggered_by matches ALL completed tax_return_submissions (no provider
-- filter — there's only one tax workflow today). Adding a tax variant later
-- = duplicate this row with a different slug + filter.
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, status, metadata
) VALUES (
  'task_workflows',
  'tax_form_review',
  'Review Tax Form Data',
  'active',
  '{
    "version": 1,
    "label_admin": "Review Tax Form Data",
    "icon": "Receipt",
    "default_assignee": "Luca",
    "default_priority": "High",
    "permission": { "role_in": ["admin", "team"] },
    "task_meta_schema": "tax_form_review_v1",
    "auto_topic": "Tax",
    "sla": { "warn_hours": 48, "escalate_hours": 96, "escalate_to": "Antonio" },
    "triggered_by": {
      "source": "form_submission",
      "table": "tax_return_submissions"
    },
    "actions": [
      {
        "slug": "approve_and_apply",
        "label_admin": "Approve & Apply Changes",
        "icon": "CheckCircle2",
        "color": "green",
        "primary": true,
        "permission": { "role_in": ["admin", "team"] },
        "handler": "tax.approve_and_apply",
        "confirm": {
          "summary": "Apply tax form corrections to CRM, enqueue data-processing job, and mark submission reviewed?"
        },
        "on_success_status": "Done"
      },
      {
        "slug": "needs_fix",
        "label_admin": "Needs Fix",
        "icon": "AlertCircle",
        "color": "amber",
        "handler": "task.flag_blocked",
        "permission": { "role_in": ["admin", "team"] },
        "requires_input": { "field": "note", "label": "What needs fixing?", "required": true },
        "on_success_status": "Waiting",
        "on_success_meta": { "workflow_state": "Needs Fix" }
      },
      {
        "slug": "waiting_client",
        "label_admin": "Waiting on Client",
        "icon": "Hourglass",
        "color": "zinc",
        "handler": "task.waiting_with_optional_message",
        "permission": { "role_in": ["admin", "team"] },
        "requires_input": { "field": "client_message_en", "label": "Optional message to client (EN)", "optional": true },
        "on_success_status": "Waiting",
        "on_success_meta": { "workflow_state": "Waiting on Client" }
      }
    ]
  }'::jsonb
)
ON CONFLICT (catalog_id, slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  status       = EXCLUDED.status,
  metadata     = EXCLUDED.metadata,
  updated_at   = now();

-- ─── itin_review — retrofit ───────────────────────────────────────────────
-- Adds triggered_by to the existing itin_review row so /api/itin-form-completed
-- uses the same generic dispatcher as banking + tax. ONE dispatch pattern
-- across the system. Existing actions/handlers/snapshot unchanged — JSON
-- jsonb_set targeting only the triggered_by key to preserve everything else.
UPDATE catalog_entries
SET metadata = jsonb_set(
      metadata,
      '{triggered_by}',
      '{"source":"form_submission","table":"itin_submissions"}'::jsonb,
      true
    ),
    updated_at = now()
WHERE catalog_id = 'task_workflows'
  AND slug = 'itin_review';
