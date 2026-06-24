-- Migration: 20260624-0400-messaging-prod-constraints-sandbox-parity
-- Bring SANDBOX messaging tables to parity with PRODUCTION by adding the CHECK
-- and UNIQUE constraints that prod already enforces but sandbox was missing.
-- This drift let invalid values ('direct' group_type, 'media' content_type,
-- 'received' status, duplicate external_message_id) pass QA in sandbox yet fail
-- against production (caused a mid-apply failure during the WhatsApp merge).
--
-- Idempotent (guarded), and uses the EXACT prod constraint names/definitions, so
-- promoting this to production is a safe no-op (the constraints already exist there).
--
-- Sandbox: node scripts/apply-migration.js scripts/migrations/20260624-0400-messaging-prod-constraints-sandbox-parity.sql
-- Production: no-op (constraints already present).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messaging_groups_group_type_check' AND conrelid = 'public.messaging_groups'::regclass) THEN
    ALTER TABLE public.messaging_groups ADD CONSTRAINT messaging_groups_group_type_check
      CHECK (group_type = ANY (ARRAY['support_group'::text, 'lead_chat'::text, 'internal'::text, 'other'::text]));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_content_type_check' AND conrelid = 'public.messages'::regclass) THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_content_type_check
      CHECK (content_type = ANY (ARRAY['text'::text, 'image'::text, 'document'::text, 'voice'::text, 'video'::text, 'location'::text, 'contact'::text, 'sticker'::text, 'other'::text]));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_direction_check' AND conrelid = 'public.messages'::regclass) THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_direction_check
      CHECK (direction = ANY (ARRAY['inbound'::text, 'outbound'::text]));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_status_check' AND conrelid = 'public.messages'::regclass) THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_status_check
      CHECK (status = ANY (ARRAY['new'::text, 'read'::text, 'draft_ready'::text, 'responded'::text, 'archived'::text, 'ignored'::text]));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_external_message_id_unique' AND conrelid = 'public.messages'::regclass) THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_external_message_id_unique UNIQUE (external_message_id);
  END IF;
END $$;
