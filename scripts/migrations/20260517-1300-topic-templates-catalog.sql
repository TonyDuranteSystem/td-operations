-- Workflow System — Slice 7: topic_templates catalog
--
-- Registers the `topic_templates` catalog and seeds 6 canonical topic
-- templates for portal-chats: ITIN, Banking, Tax, Lease, Closure, General.
--
-- Today the "+ Create a new topic" button at portal-chats/page.tsx:2046
-- opens a free-text input. Admin types whatever, the topic string is saved
-- on the next sent message (portal_messages.topic). Topics are derived from
-- messages — no persistence layer for what topics exist.
--
-- Slice 7 adds a curated template dropdown. Admin clicks "ITIN" → fires
-- api_call to POST /api/portal/chat/topic/create → server inserts a bilingual
-- starter admin message with topic = "ITIN" in the client's language
-- (contacts.language or default 'en'). From that point onward the topic tab
-- exists (derived from messages). Free-text input remains available as a
-- "Custom..." fallback option.
--
-- The row shape follows the locked 🔒 Principle of Flexibility:
--   - surface = "portal_chat_topic_create" (new surface; existing chat_quick_actions
--     uses "portal_chat_message")
--   - handler.kind = "api_call" with body_template carrying topic_name + starter
--     messages + interpolated context tokens
--   - on_success.set_active_topic = true (chat-specific UX: after creation,
--     switch the page to the new topic)
--
-- Slice 7 is the first consumer of the api_call primitive — implementation
-- ships in the same slice in lib/chat/handler-primitives.ts.
--
-- Idempotent: definition uses ON CONFLICT DO NOTHING; entries use ON CONFLICT
-- DO UPDATE so metadata edits flow through.
--
-- Dev task: e364e980 (Workflow System full build, parent).

BEGIN;

-- 1. catalog_definitions row --------------------------------------------------
INSERT INTO catalog_definitions (id, display_name, description, admin_can_add_rows, tags_schema)
VALUES (
  'topic_templates',
  'Topic Templates',
  'Curated templates for the "Open new topic" selector in portal-chats. Each row defines a topic name, an icon, a bilingual starter message, and how it fires (api_call to POST /api/portal/chat/topic/create by default). Adding a new template is a SQL insert via catalog_add MCP or (once shipped) the /catalog page. The seven existing rows (ITIN, Banking, Tax, Lease, Closure, General + Custom-fallback handled in code) cover today; adding a per-service topic for a new service like DBA is one new catalog row.',
  true,
  NULL
)
ON CONFLICT (id) DO NOTHING;

-- 2. Seed rows ---------------------------------------------------------------
-- Each template uses api_call to POST /api/portal/chat/topic/create. The
-- server reads the contact's language (or falls back to 'en') and posts the
-- matching starter message with topic = topic_name. The 6 templates here
-- cover today's services; adding a new one (e.g. "DBA Filing") is a single
-- INSERT with no code change.

-- 2.1 ITIN -------------------------------------------------------------------
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, display_name_translations,
  description, status, tags, capabilities, metadata
) VALUES (
  'topic_templates',
  'itin',
  'ITIN',
  '{"it": "ITIN"}'::jsonb,
  'Topic for ITIN application discussions — form review, mailing instructions, IRS processing updates, ITIN delivery.',
  'active',
  '["chat", "topic"]'::jsonb,
  '{}'::jsonb,
  $json${
    "surface": "portal_chat_topic_create",
    "order": 10,
    "icon": "FileSignature",
    "color": "default",
    "permission": { "role_in": ["admin", "team"] },
    "requires_all": [],
    "requires_any": ["account_id", "contact_id"],
    "handler": {
      "kind": "api_call",
      "method": "POST",
      "url_template": "/api/portal/chat/topic/create",
      "body_template": {
        "topic_name": "ITIN",
        "account_id": "{account_id}",
        "contact_id": "{contact_id}",
        "starter_message_en": "Hi! Opening a dedicated topic for your ITIN application — we will use this thread for all ITIN-related updates (form review, mailing instructions, IRS processing status, and delivery).",
        "starter_message_it": "Ciao! Apriamo un argomento dedicato per la tua domanda ITIN — useremo questo thread per tutti gli aggiornamenti relativi all'ITIN (revisione moduli, istruzioni di spedizione, stato elaborazione IRS e consegna)."
      }
    },
    "on_success": {
      "toast": "ITIN topic opened",
      "set_active_topic": true,
      "close_menu": true
    }
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

-- 2.2 Banking ----------------------------------------------------------------
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, display_name_translations,
  description, status, tags, capabilities, metadata
) VALUES (
  'topic_templates',
  'banking',
  'Banking',
  '{"it": "Banking"}'::jsonb,
  'Topic for banking discussions — account opening, Relay/PayrollIQ/Mercury status, debit card delivery, statements.',
  'active',
  '["chat", "topic"]'::jsonb,
  '{}'::jsonb,
  $json${
    "surface": "portal_chat_topic_create",
    "order": 20,
    "icon": "Landmark",
    "color": "default",
    "permission": { "role_in": ["admin", "team"] },
    "requires_all": [],
    "requires_any": ["account_id", "contact_id"],
    "handler": {
      "kind": "api_call",
      "method": "POST",
      "url_template": "/api/portal/chat/topic/create",
      "body_template": {
        "topic_name": "Banking",
        "account_id": "{account_id}",
        "contact_id": "{contact_id}",
        "starter_message_en": "Hi! Opening a topic for your business banking setup — we will use this thread for account opening updates, statements, debit card delivery, and any banking-related questions.",
        "starter_message_it": "Ciao! Apriamo un argomento per la configurazione del tuo conto bancario aziendale — useremo questo thread per aggiornamenti sull'apertura del conto, estratti conto, consegna della carta di debito e qualsiasi domanda relativa al banking."
      }
    },
    "on_success": {
      "toast": "Banking topic opened",
      "set_active_topic": true,
      "close_menu": true
    }
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

-- 2.3 Tax --------------------------------------------------------------------
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, display_name_translations,
  description, status, tags, capabilities, metadata
) VALUES (
  'topic_templates',
  'tax',
  'Tax',
  '{"it": "Tasse"}'::jsonb,
  'Topic for tax discussions — quarterly estimates, year-end filings, extension requests, tax-form questions.',
  'active',
  '["chat", "topic"]'::jsonb,
  '{}'::jsonb,
  $json${
    "surface": "portal_chat_topic_create",
    "order": 30,
    "icon": "Calculator",
    "color": "default",
    "permission": { "role_in": ["admin", "team"] },
    "requires_all": [],
    "requires_any": ["account_id", "contact_id"],
    "handler": {
      "kind": "api_call",
      "method": "POST",
      "url_template": "/api/portal/chat/topic/create",
      "body_template": {
        "topic_name": "Tax",
        "account_id": "{account_id}",
        "contact_id": "{contact_id}",
        "starter_message_en": "Hi! Opening a topic for tax matters — we will use this thread for quarterly estimates, year-end filings, extension requests, and tax-form questions.",
        "starter_message_it": "Ciao! Apriamo un argomento per le questioni fiscali — useremo questo thread per stime trimestrali, dichiarazioni di fine anno, richieste di proroga e domande sui moduli fiscali."
      }
    },
    "on_success": {
      "toast": "Tax topic opened",
      "set_active_topic": true,
      "close_menu": true
    }
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

-- 2.4 Lease ------------------------------------------------------------------
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, display_name_translations,
  description, status, tags, capabilities, metadata
) VALUES (
  'topic_templates',
  'lease',
  'Lease',
  '{"it": "Affitto"}'::jsonb,
  'Topic for lease and address discussions — virtual office contract review, address changes, mail forwarding.',
  'active',
  '["chat", "topic"]'::jsonb,
  '{}'::jsonb,
  $json${
    "surface": "portal_chat_topic_create",
    "order": 40,
    "icon": "Home",
    "color": "default",
    "permission": { "role_in": ["admin", "team"] },
    "requires_all": [],
    "requires_any": ["account_id", "contact_id"],
    "handler": {
      "kind": "api_call",
      "method": "POST",
      "url_template": "/api/portal/chat/topic/create",
      "body_template": {
        "topic_name": "Lease",
        "account_id": "{account_id}",
        "contact_id": "{contact_id}",
        "starter_message_en": "Hi! Opening a topic for lease and address matters — we will use this thread for virtual office contracts, address changes, and mail forwarding.",
        "starter_message_it": "Ciao! Apriamo un argomento per questioni di affitto e indirizzo — useremo questo thread per contratti di ufficio virtuale, cambi di indirizzo e inoltro della posta."
      }
    },
    "on_success": {
      "toast": "Lease topic opened",
      "set_active_topic": true,
      "close_menu": true
    }
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

-- 2.5 Closure ----------------------------------------------------------------
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, display_name_translations,
  description, status, tags, capabilities, metadata
) VALUES (
  'topic_templates',
  'closure',
  'Closure',
  '{"it": "Chiusura"}'::jsonb,
  'Topic for LLC closure discussions — dissolution filing, final tax return, account closure.',
  'active',
  '["chat", "topic"]'::jsonb,
  '{}'::jsonb,
  $json${
    "surface": "portal_chat_topic_create",
    "order": 50,
    "icon": "XCircle",
    "color": "default",
    "permission": { "role_in": ["admin", "team"] },
    "requires_all": [],
    "requires_any": ["account_id", "contact_id"],
    "handler": {
      "kind": "api_call",
      "method": "POST",
      "url_template": "/api/portal/chat/topic/create",
      "body_template": {
        "topic_name": "Closure",
        "account_id": "{account_id}",
        "contact_id": "{contact_id}",
        "starter_message_en": "Hi! Opening a topic for the LLC closure process — we will use this thread for dissolution filing, final tax return, and account closure steps.",
        "starter_message_it": "Ciao! Apriamo un argomento per il processo di chiusura della LLC — useremo questo thread per la dichiarazione di scioglimento, la dichiarazione fiscale finale e i passaggi di chiusura del conto."
      }
    },
    "on_success": {
      "toast": "Closure topic opened",
      "set_active_topic": true,
      "close_menu": true
    }
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

-- 2.6 General ----------------------------------------------------------------
INSERT INTO catalog_entries (
  catalog_id, slug, display_name, display_name_translations,
  description, status, tags, capabilities, metadata
) VALUES (
  'topic_templates',
  'general',
  'General',
  '{"it": "Generale"}'::jsonb,
  'Catch-all topic for questions that do not fit a specific service area.',
  'active',
  '["chat", "topic"]'::jsonb,
  '{}'::jsonb,
  $json${
    "surface": "portal_chat_topic_create",
    "order": 99,
    "icon": "MessageCircle",
    "color": "default",
    "permission": { "role_in": ["admin", "team"] },
    "requires_all": [],
    "requires_any": ["account_id", "contact_id"],
    "handler": {
      "kind": "api_call",
      "method": "POST",
      "url_template": "/api/portal/chat/topic/create",
      "body_template": {
        "topic_name": "General",
        "account_id": "{account_id}",
        "contact_id": "{contact_id}",
        "starter_message_en": "Hi! Opening a general topic — we will use this thread for any question that does not fit a specific service area.",
        "starter_message_it": "Ciao! Apriamo un argomento generale — useremo questo thread per qualsiasi domanda che non rientra in un'area di servizio specifica."
      }
    },
    "on_success": {
      "toast": "General topic opened",
      "set_active_topic": true,
      "close_menu": true
    }
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

-- 3. Decision-log entries (idempotent) ---------------------------------------
INSERT INTO catalog_decision_log (
  catalog_entry_id, catalog_id, action, actor_kind, reason, after_state
)
SELECT
  ce.id,
  ce.catalog_id,
  'added'::text,
  'migration'::text,
  'Slice 7 — topic_templates catalog foundation (6 canonical templates: ITIN, Banking, Tax, Lease, Closure, General). Each fires api_call to POST /api/portal/chat/topic/create which inserts a bilingual starter admin message with topic = template name. Adding a new service-specific topic is a single SQL insert per the Principle of Flexibility.',
  jsonb_build_object(
    'slug', ce.slug,
    'display_name', ce.display_name,
    'status', ce.status,
    'metadata', ce.metadata
  )
FROM catalog_entries ce
WHERE ce.catalog_id = 'topic_templates'
  AND ce.slug IN ('itin', 'banking', 'tax', 'lease', 'closure', 'general')
  AND NOT EXISTS (
    SELECT 1 FROM catalog_decision_log dl
    WHERE dl.catalog_entry_id = ce.id
      AND dl.action = 'added'
  );

COMMIT;
