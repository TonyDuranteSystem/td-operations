-- Migration: enable system-authored portal chat events
-- Branch: feat/contact-add-service-flexible
-- Date: 2026-05-18
--
-- Two changes:
--   1) portal_messages.sender_type CHECK now accepts 'system' in addition to
--      'client' and 'admin'. System messages are authored by the platform
--      (e.g. when a client submits a wizard) and surfaced in the portal-chats
--      thread with a distinct UI style. They count toward the per-topic unread
--      badge but are excluded from the R103 admin-email notification cron.
--
--   2) Three new entries in catalog_entries(catalog_id='topic_templates'):
--      'formation', 'documents', 'billing'. Mirrors the shape of the existing
--      6 topic_templates rows (banking, closure, general, itin, lease, tax).
--      These three topics are used as auto_topic targets for system events
--      emitted on workflow dispatch, document upload, payment received,
--      SS-4 signed, etc. Adding them to the catalog also makes them
--      available in the manual "Create new topic" menu.
--
-- Sandbox vs production: sandbox currently has no CHECK constraint on
-- sender_type (drift); production has one with ('client','admin') only.
-- DROP IF EXISTS handles both safely.

BEGIN;

-- 1) sender_type CHECK constraint: add 'system'
ALTER TABLE portal_messages DROP CONSTRAINT IF EXISTS portal_messages_sender_type_check;
ALTER TABLE portal_messages ADD CONSTRAINT portal_messages_sender_type_check
  CHECK (sender_type = ANY (ARRAY['client'::text, 'admin'::text, 'system'::text]));

-- 2) topic_templates: formation, documents, billing
-- Idempotent: ON CONFLICT skips if slug already exists for this catalog.
-- metadata.handler mirrors existing rows so the admin-side "Create topic"
-- menu can fire the same /api/portal/chat/topic/create flow.

INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata)
VALUES
  ('topic_templates', 'formation', 'Formation', 'active',
   jsonb_build_object(
     'icon', 'Building2',
     'color', 'default',
     'order', 5,
     'handler', jsonb_build_object(
       'kind', 'api_call',
       'method', 'POST',
       'url_template', '/api/portal/chat/topic/create',
       'body_template', jsonb_build_object(
         'account_id', '{account_id}',
         'contact_id', '{contact_id}',
         'topic_name', 'Formation',
         'starter_message_en', 'Hi! Opening a topic for company formation.',
         'starter_message_it', 'Ciao! Apriamo un argomento per la costituzione della LLC.'
       )
     ),
     'surface', 'portal_chat_topic_create',
     'on_success', jsonb_build_object(
       'toast', 'Formation topic opened',
       'close_menu', true,
       'set_active_topic', true
     ),
     'permission', jsonb_build_object('role_in', jsonb_build_array('admin', 'team')),
     'requires_all', '[]'::jsonb,
     'requires_any', jsonb_build_array('account_id', 'contact_id')
   )),
  ('topic_templates', 'documents', 'Documents', 'active',
   jsonb_build_object(
     'icon', 'FileText',
     'color', 'default',
     'order', 60,
     'handler', jsonb_build_object(
       'kind', 'api_call',
       'method', 'POST',
       'url_template', '/api/portal/chat/topic/create',
       'body_template', jsonb_build_object(
         'account_id', '{account_id}',
         'contact_id', '{contact_id}',
         'topic_name', 'Documents',
         'starter_message_en', 'Hi! Opening a topic for document exchange.',
         'starter_message_it', 'Ciao! Apriamo un argomento per lo scambio di documenti.'
       )
     ),
     'surface', 'portal_chat_topic_create',
     'on_success', jsonb_build_object(
       'toast', 'Documents topic opened',
       'close_menu', true,
       'set_active_topic', true
     ),
     'permission', jsonb_build_object('role_in', jsonb_build_array('admin', 'team')),
     'requires_all', '[]'::jsonb,
     'requires_any', jsonb_build_array('account_id', 'contact_id')
   )),
  ('topic_templates', 'billing', 'Billing', 'active',
   jsonb_build_object(
     'icon', 'CreditCard',
     'color', 'default',
     'order', 70,
     'handler', jsonb_build_object(
       'kind', 'api_call',
       'method', 'POST',
       'url_template', '/api/portal/chat/topic/create',
       'body_template', jsonb_build_object(
         'account_id', '{account_id}',
         'contact_id', '{contact_id}',
         'topic_name', 'Billing',
         'starter_message_en', 'Hi! Opening a topic for billing and payment matters.',
         'starter_message_it', 'Ciao! Apriamo un argomento per fatturazione e pagamenti.'
       )
     ),
     'surface', 'portal_chat_topic_create',
     'on_success', jsonb_build_object(
       'toast', 'Billing topic opened',
       'close_menu', true,
       'set_active_topic', true
     ),
     'permission', jsonb_build_object('role_in', jsonb_build_array('admin', 'team')),
     'requires_all', '[]'::jsonb,
     'requires_any', jsonb_build_array('account_id', 'contact_id')
   ))
ON CONFLICT (catalog_id, slug) DO NOTHING;

COMMIT;
