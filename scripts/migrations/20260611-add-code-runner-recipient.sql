-- Migration: 20260611-add-code-runner-recipient.sql
-- Add 'code_runner' as an agent_message_party enum value so the Slack worker's
-- start_code_task tool can address a code-implementation task to the Mac Mini
-- runner (scripts/mac-mini/code-task-runner.mjs). The runner polls
-- agent_messages WHERE recipient='code_runner' AND status='pending'.
-- Safe: ADD VALUE is non-destructive and does not lock the table.

ALTER TYPE agent_message_party ADD VALUE IF NOT EXISTS 'code_runner';
