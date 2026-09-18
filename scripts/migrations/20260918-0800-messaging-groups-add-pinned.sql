-- Migration: 20260918-0800-messaging-groups-add-pinned
-- Adds a pinned flag to messaging_groups so a WhatsApp conversation can be
-- pinned to the top of the list, matching the existing Gmail star/pin
-- feature (Antonio, 2026-09-18 — wants pin/mark-unread/delete/sticky-note
-- parity with Gmail's row hover actions). No existing column captures this
-- for a WhatsApp conversation — confirmed by reading the live schema before
-- writing this migration.
--
-- Sandbox: run via   node scripts/apply-migration.js scripts/migrations/20260918-0800-messaging-groups-add-pinned.sql
-- Production: after sandbox QA, apply via execute_sql with reason "migration:20260918-0800-messaging-groups-add-pinned.sql"

BEGIN;

ALTER TABLE messaging_groups ADD COLUMN pinned boolean NOT NULL DEFAULT false;

COMMIT;
