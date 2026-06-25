-- Migration: 20260623-2300-messaging-groups-unique-channel-external
-- Ensures the composite unique index the WhatsApp importer relies on for its
-- upsert ON CONFLICT (channel_id, external_group_id) exists.
--
-- Production already has this index (messaging_groups_channel_id_external_group_id_key);
-- sandbox had drifted and was missing it, which made the importer's upsert fail.
-- IF NOT EXISTS keeps this a safe no-op where the index is already present.
--
-- Sandbox: node scripts/apply-migration.js scripts/migrations/20260623-2300-messaging-groups-unique-channel-external.sql
-- Production: no-op (index already exists).

CREATE UNIQUE INDEX IF NOT EXISTS messaging_groups_channel_id_external_group_id_key
  ON public.messaging_groups USING btree (channel_id, external_group_id);
