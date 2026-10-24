-- UNDO for 20261023-2000-marketing-lead-chat.sql. Drops the lead chat (every message, reaction and read marker) and the push subscriptions. Run only on purpose.
-- Files in the private bucket marketing-chat are NOT deleted here: empty the bucket from Storage first if you want them gone, then remove it.
DROP TABLE IF EXISTS marketing_lead_message_reactions;
DROP TABLE IF EXISTS marketing_lead_chat_delivery;
DROP TABLE IF EXISTS marketing_lead_chat_reads;
DROP TABLE IF EXISTS marketing_lead_messages;
DROP TABLE IF EXISTS marketing_push_subscriptions;
