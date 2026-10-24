-- UNDO for 20261024-2100-marketing-team-chat.sql. Drops the team chat (every conversation, message, reaction and read marker) and the mentions column of the lead chat. Run only on purpose.
-- Files in the private bucket marketing-chat are NOT deleted here.
DROP TABLE IF EXISTS marketing_team_message_reactions;
DROP TABLE IF EXISTS marketing_team_chat_delivery;
DROP TABLE IF EXISTS marketing_team_chat_reads;
DROP TABLE IF EXISTS marketing_team_messages;
DROP TABLE IF EXISTS marketing_chat_thread_members;
DROP TABLE IF EXISTS marketing_chat_threads;
ALTER TABLE marketing_lead_messages DROP COLUMN IF EXISTS mentions;
