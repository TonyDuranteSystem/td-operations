-- ============================================================================
-- Tax Return chat tab "Tax Return 2026" -> "Tax Return 2025"  (dev job 524d5e44, DATA ONLY — no DDL)
-- Antonio 2026-11-05: "change the wording Tax Return 2026 in 2025, that is correct".
--
-- WHY: the chat topic is stamped by buildFlowTopic(service_type, deriveFlowYear(sd)). Every Tax Return
-- pipeline on production has no deadline and was created in 2026, so the year came from the date the job
-- was last moved (2026) and the 2025 returns got the tab "Tax Return 2026". The code fix
-- (lib/flows/resolve-flows.ts taxReturnYear) makes NEW messages say 2025; this file renames the OLD ones
-- so the client keeps ONE tab (not "2026" for old messages and "2025" for new ones).
--
-- MEASURED on production 2026-11-05 before writing this: 290 rows with topic 'Tax Return 2026' (289 live,
-- 1 deleted; 33 company chats + 33 personal-scope rows), no other tax topic name, no 'Tax Return 2025' topic
-- yet, 39 portal_notifications links of the form  topic=Tax%20Return%202026 , and no trigger on
-- portal_messages / portal_notifications (a rename sends nothing and recounts nothing).
--
-- SAFETY:
--   * Only rows created before 2027-01-01: a real tab for tax year 2026 can only appear in 2027, so this
--     can never touch a genuine 2026 tab, and re-running it later is harmless (second run = 0 rows).
--   * Only the tab name changes — message text, sender, read state, attachments are untouched.
--   * A client who opens an OLD emailed link (topic=Tax%20Return%202026) after this lands on General
--     (the portal chat's own rule "topic not found -> General, never an empty tab"); the 39 STORED links
--     are rewritten below so bell entries open the renamed tab.
--   * Undo: 20261106-0100-tax-return-chat-topic-2025.UNDO.sql (exact, because no 'Tax Return 2025' topic
--     existed before this ran).
-- ============================================================================

UPDATE portal_messages
   SET topic = 'Tax Return 2025'
 WHERE topic = 'Tax Return 2026'
   AND created_at < '2027-01-01';

UPDATE portal_notifications
   SET link = replace(link, 'topic=Tax%20Return%202026', 'topic=Tax%20Return%202025')
 WHERE link LIKE '%topic=Tax%20Return%202026%'
   AND created_at < '2027-01-01';
