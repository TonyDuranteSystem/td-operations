-- UNDO for 20261110-1200-portal-chat-people-thread-keys.sql
-- Safe at any time: the threads route treats a missing function as "no flag" and the Chats chip shows everything.
DROP FUNCTION IF EXISTS public.get_portal_chat_people_thread_keys();
