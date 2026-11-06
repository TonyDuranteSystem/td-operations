-- UNDO of 20261106-0100-tax-return-chat-topic-2025.sql (dev job 524d5e44).
-- Exact only while no REAL 'Tax Return 2025' tab message was written after the migration ran: set :run_time to the
-- moment the migration was applied (e.g. '2026-11-06 01:30:00+00'); rows created before it are exactly the renamed ones.
-- Usage:  psql -v run_time="'2026-11-06 01:30:00+00'" -f 20261106-0100-tax-return-chat-topic-2025.UNDO.sql

UPDATE portal_messages
   SET topic = 'Tax Return 2026'
 WHERE topic = 'Tax Return 2025'
   AND created_at < :run_time::timestamptz;

UPDATE portal_notifications
   SET link = replace(link, 'topic=Tax%20Return%202025', 'topic=Tax%20Return%202026')
 WHERE link LIKE '%topic=Tax%20Return%202025%'
   AND created_at < :run_time::timestamptz;
