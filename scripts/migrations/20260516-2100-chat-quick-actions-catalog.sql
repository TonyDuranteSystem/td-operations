-- Workflow System — Slice 6a: chat_quick_actions catalog foundation
--
-- Registers a new catalog `chat_quick_actions` and seeds the three current
-- per-message "Create" items that today live as hardcoded JSX in
-- app/(dashboard)/portal-chats/page.tsx lines 2112-2129.
--
-- Slice 6a is FOUNDATION ONLY: no client code consumes this catalog yet.
-- The portal-chats page refactor is Slice 6b, behind a feature flag, with
-- automatic fallback to the existing hardcoded items.
--
-- The row shape (metadata fields) mirrors task_workflows actions vocabulary
-- (permission, handler, handler_params) so chat actions and workflow actions
-- share one mental model. Chat-specific fields: surface, order,
-- requires_all, requires_any. Optional fields (confirm, on_success,
-- visibility) are not needed by any of the three seeded rows — added later
-- if a future row requires them. JSONB metadata accepts additive fields
-- with no migration.
--
-- Context-requirement model (designed for maximum future flexibility):
--   - requires_all: string[]  — ALL listed context tokens must be present
--                                (AND). Defaults to [] when omitted.
--   - requires_any: string[]  — at least ONE listed token must be present
--                                (OR). Defaults to [] when omitted.
--   Both empty = item is always visible. Lists can be combined.
--
--   Context tokens are FREE-FORM strings supplied by the page's
--   context-builder. To support a brand-new dimension (e.g. referrer_contact_id,
--   member_id, deal_id, partner_id), one line is added to the page's
--   context object; after that any number of future catalog rows can
--   reference the new token via pure catalog edits, no code change.
--
-- Why the three seeded rows below all require account_id today:
--   QuickCreateModal at portal-chats/page.tsx:2819-2826 currently takes
--   accountId as a required prop. The seed reflects the handler's CURRENT
--   capability, not the catalog shape's flexibility. When the modal is
--   later upgraded to accept either accountId OR contactId (clean handler
--   upgrade in a separate slice), the seed becomes a one-line catalog edit:
--     requires_all: []
--     requires_any: ["account_id", "contact_id"]
--
-- See sysdocs:
--   'workflows-system-master-plan' (Slice 6 in the build sequence)
--   'ops-2026-05-15-workflow-system-slice-0-audit' (Errata)
-- Dev task e364e980-8474-4410-8a6c-08f7e24a675d.
--
-- Idempotent: re-running is a no-op (definition uses ON CONFLICT DO NOTHING;
-- entries use ON CONFLICT DO UPDATE so metadata edits flow through).

BEGIN;

-- 1. catalog_definitions row --------------------------------------------------
INSERT INTO catalog_definitions (id, display_name, description, admin_can_add_rows, tags_schema)
VALUES (
  'chat_quick_actions',
  'Chat Quick Actions',
  'Items rendered in the dropdown menus inside portal-chats (per-message "Create" section today; future surfaces include the internal-thread header and topic actions). Each row declares its surface, ordering, icon, RBAC, required context, and the client-side handler that fires on click. Edit via the /catalog page (once generalized) or via catalog_add/catalog_update MCP tools.',
  true,
  NULL
)
ON CONFLICT (id) DO NOTHING;

-- 2. Seed: create_task --------------------------------------------------------
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, display_name_translations,
  description, status, tags, capabilities, metadata
) VALUES (
  'chat_quick_actions',
  'create_task',
  'Task',
  '{"it": "Task"}'::jsonb,
  'Opens the QuickCreate modal pre-filled with the message text so the admin can convert a chat message into a new task on the selected account.',
  'active',
  '["chat", "create"]'::jsonb,
  '{}'::jsonb,
  $json${
    "surface": "portal_chat_message",
    "order": 10,
    "icon": "ClipboardList",
    "permission": { "role_in": ["admin", "team"] },
    "requires_all": ["account_id"],
    "requires_any": [],
    "handler": "chat.quick_create",
    "handler_params": { "create_type": "task" }
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

-- 3. Seed: create_sd ----------------------------------------------------------
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, display_name_translations,
  description, status, tags, capabilities, metadata
) VALUES (
  'chat_quick_actions',
  'create_sd',
  'Service',
  '{"it": "Servizio"}'::jsonb,
  'Opens the QuickCreate modal to create a new Service Delivery on the selected account from the message context.',
  'active',
  '["chat", "create"]'::jsonb,
  '{}'::jsonb,
  $json${
    "surface": "portal_chat_message",
    "order": 20,
    "icon": "Truck",
    "permission": { "role_in": ["admin", "team"] },
    "requires_all": ["account_id"],
    "requires_any": [],
    "handler": "chat.quick_create",
    "handler_params": { "create_type": "sd" }
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

-- 4. Seed: create_invoice -----------------------------------------------------
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, display_name_translations,
  description, status, tags, capabilities, metadata
) VALUES (
  'chat_quick_actions',
  'create_invoice',
  'Invoice',
  '{"it": "Fattura"}'::jsonb,
  'Opens the QuickCreate modal to create a new TD invoice (payment) on the selected account from the message context.',
  'active',
  '["chat", "create"]'::jsonb,
  '{}'::jsonb,
  $json${
    "surface": "portal_chat_message",
    "order": 30,
    "icon": "Receipt",
    "permission": { "role_in": ["admin", "team"] },
    "requires_all": ["account_id"],
    "requires_any": [],
    "handler": "chat.quick_create",
    "handler_params": { "create_type": "invoice" }
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

-- 5. Decision log entries -----------------------------------------------------
INSERT INTO catalog_decision_log (
  catalog_entry_id, catalog_id, action, actor_kind, reason, after_state
)
SELECT
  ce.id,
  ce.catalog_id,
  'added'::text,
  'migration'::text,
  'Slice 6a — chat_quick_actions foundation seed (3 rows mirror current portal-chats per-message Create section). No client code consumes this yet; the page refactor is Slice 6b behind a feature flag.',
  jsonb_build_object(
    'slug', ce.slug,
    'display_name', ce.display_name,
    'status', ce.status,
    'metadata', ce.metadata
  )
FROM catalog_entries ce
WHERE ce.catalog_id = 'chat_quick_actions'
  AND ce.slug IN ('create_task', 'create_sd', 'create_invoice')
  AND NOT EXISTS (
    SELECT 1 FROM catalog_decision_log dl
    WHERE dl.catalog_entry_id = ce.id
      AND dl.action = 'added'
  );

COMMIT;
