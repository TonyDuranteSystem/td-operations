-- CRM worker (inbox panel + portal-chats Worker tab) records its exchanges
-- in agent_messages. sender/recipient use the agent_message_party enum —
-- add 'crm' so the rows are honestly labeled (sender='crm',
-- recipient='worker'; recipient 'worker' is claimed by NO cron, keeping the
-- CRM rail isolated from the Slack + dormant Hermes queues).
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block.

ALTER TYPE agent_message_party ADD VALUE IF NOT EXISTS 'crm';
