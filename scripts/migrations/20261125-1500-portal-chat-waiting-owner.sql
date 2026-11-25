-- Portal Chats: an OWNER on a "Waiting on us" mark (2026-11-25, dev job 40b5fd59)
-- Antonio: each conversation the client is waiting on us for belongs to one team member (Antonio or someone else), so the
-- "Waiting on us" card can show whose turn it is and filter per person.
--
-- assigned_to = the staff login (auth user id) who answers. NULL = not assigned (every mark that exists today).
-- Deliberately NO foreign key and NO check list: staff logins live in auth, the server validates who may be chosen, and a
-- new constraint on the shared sandbox would turn other sessions' checks red.
-- Only 'us' marks use it; a 'client' mark (waiting for the client) never carries an owner.

ALTER TABLE public.portal_chat_waiting_threads
  ADD COLUMN IF NOT EXISTS assigned_to UUID;
