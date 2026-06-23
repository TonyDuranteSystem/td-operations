-- Client Threads — Phase 2 (dev_task 54f89912)
-- Add 'Slack' to the conversation_channel enum so a tagged Slack client-thread
-- exchange can be recorded in the CRM `conversations` log (readable in the
-- account/contact Activity tab) with the correct channel.
--
-- ALTER TYPE ... ADD VALUE is additive and safe (no existing rows affected).
-- Apply to sandbox via the sandbox MCP (single statement) or apply-migration.js;
-- promote to production in the Supabase SQL editor (DDL is gated from execute_sql).

ALTER TYPE conversation_channel ADD VALUE IF NOT EXISTS 'Slack';
