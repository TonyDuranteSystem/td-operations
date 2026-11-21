-- Portal Chats: "Waiting on us" (2026-11-21, dev job 954af5db)
-- The conversation mark now has two kinds: 'client' (we wait for the client — the original mark, with the 3-day reminder)
-- and 'us' (the client is waiting for us — no reminder to the client; ends by itself when staff write after the mark).
-- One mark per conversation: setting one kind replaces the other (the unique indexes already allow one row per conversation).

ALTER TABLE public.portal_chat_waiting_threads
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'client' CHECK (kind IN ('client', 'us'));
