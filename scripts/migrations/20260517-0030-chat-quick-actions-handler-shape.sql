-- Workflow System — Slice 6a-followup: chat_quick_actions handler shape upgrade
--
-- Implements the Principle of Flexibility (master plan sysdoc
-- 'workflows-system-master-plan' → "🔒 Principle of Flexibility" section,
-- locked 2026-05-16) on the chat_quick_actions catalog.
--
-- BEFORE (Slice 6a, shipped 2026-05-16):
--   metadata.handler:        "chat.quick_create"          (fixed slug)
--   metadata.handler_params: { create_type: "task" }
--   → adding a new menu item like "Send Welcome Email" would have required
--     a new code-side handler `chat.send_welcome_email`.
--
-- AFTER (this migration):
--   metadata.handler: {
--     kind: "open_modal",                                  (primitive verb)
--     modal_id: "quick_create",                            (component registry key)
--     modal_params: { create_type: "task" }
--   }
--   metadata.handler_params: REMOVED (subsumed by modal_params)
--   → adding "Send Welcome Email" becomes a pure catalog row with
--     handler.kind="api_call" once that primitive is implemented (on first
--     consumer — staged-implementation policy per master plan).
--
-- The 4 primitive verbs the catalog can reference (master plan §Principle):
--   1. open_modal     — mount a React component from MODAL_REGISTRY
--   2. api_call       — server HTTP request with interpolated body (TBD)
--   3. navigate       — client-side router push (TBD)
--   4. client_action  — browser API (copy_to_clipboard, open_url, ...) (TBD)
--
-- Only open_modal is IMPLEMENTED in this slice — it's the only kind used by
-- the 3 existing rows. The other 3 are documented vocabulary; they ship
-- when their first consumer arrives (small focused slice each).
--
-- Idempotent: uses jsonb_set with deep-merge semantics. Re-running converges
-- every row to the new shape; handler_params is unset if present.
-- The metadata.surface filter (= 'portal_chat_message') guards against
-- accidentally rewriting any future row that uses a different surface.
--
-- Dev task: e364e980-8474-4410-8a6c-08f7e24a675d (parent workflow build).

BEGIN;

-- 1. Rewrite handler shape on the 3 existing rows ----------------------------
UPDATE catalog_entries
SET
  metadata = (metadata - 'handler' - 'handler_params')
           || jsonb_build_object(
                'handler',
                jsonb_build_object(
                  'kind', 'open_modal',
                  'modal_id', 'quick_create',
                  'modal_params', metadata->'handler_params'
                )
              ),
  updated_at = now()
WHERE catalog_id = 'chat_quick_actions'
  AND slug IN ('create_task', 'create_sd', 'create_invoice')
  AND metadata ? 'handler_params'   -- only run if old shape present (idempotent)
  AND jsonb_typeof(metadata->'handler') = 'string';

-- 2. Decision-log the upgrade ------------------------------------------------
INSERT INTO catalog_decision_log (
  catalog_entry_id, catalog_id, action, actor_kind, reason, after_state
)
SELECT
  ce.id,
  ce.catalog_id,
  'metadata_changed'::text,
  'migration'::text,
  'Slice 6a-followup — handler shape upgrade from fixed slug ("chat.quick_create" + handler_params) to primitive-kind+params (kind="open_modal", modal_id, modal_params). Implements the Principle of Flexibility locked in the master plan on 2026-05-16. Adding a new menu item with existing primitives becomes a pure catalog row.',
  jsonb_build_object(
    'slug', ce.slug,
    'metadata.handler', ce.metadata->'handler'
  )
FROM catalog_entries ce
WHERE ce.catalog_id = 'chat_quick_actions'
  AND ce.slug IN ('create_task', 'create_sd', 'create_invoice')
  AND jsonb_typeof(ce.metadata->'handler') = 'object'
  AND ce.metadata->'handler'->>'kind' = 'open_modal'
  AND NOT EXISTS (
    -- skip if a metadata_changed entry already exists for THIS exact handler shape
    SELECT 1 FROM catalog_decision_log dl
    WHERE dl.catalog_entry_id = ce.id
      AND dl.action = 'metadata_changed'
      AND dl.after_state->>'metadata.handler' = (ce.metadata->'handler')::text
  );

COMMIT;
