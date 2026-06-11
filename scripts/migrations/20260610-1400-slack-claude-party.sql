-- Migration: 20260610-1400-slack-claude-party.sql
-- Add 'slack' as an agent_message_party enum value so Slack-sourced messages
-- in the agent bridge carry a semantically correct sender value.
-- Safe: ADD VALUE is non-destructive and does not lock the table.

ALTER TYPE agent_message_party ADD VALUE IF NOT EXISTS 'slack';
