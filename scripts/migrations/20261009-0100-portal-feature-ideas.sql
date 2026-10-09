-- Client invoicing: "Do you have an idea? Share it with us" (dev job 1a23f5f1, Antonio 2026-10-08).
-- A client types an idea in the box at the bottom of Customers & Invoices; staff read it in Portal Chats, in a new
-- "Idea request" tab next to "What's New", with a blue dot while it is unhandled.
-- Staff-only table: RLS on, no policies (server/service role only). The client never reads it back.
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.portal_feature_ideas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid,
  contact_id   uuid,
  auth_user_id uuid NOT NULL,
  idea         text NOT NULL CHECK (char_length(idea) BETWEEN 5 AND 1500),
  source       text NOT NULL DEFAULT 'invoicing-hub',
  created_at   timestamptz NOT NULL DEFAULT now(),
  handled_at   timestamptz,
  handled_by   text
);

CREATE INDEX IF NOT EXISTS portal_feature_ideas_account_open_idx ON public.portal_feature_ideas (account_id, created_at DESC) WHERE handled_at IS NULL;
CREATE INDEX IF NOT EXISTS portal_feature_ideas_contact_idx ON public.portal_feature_ideas (contact_id, created_at DESC);

ALTER TABLE public.portal_feature_ideas ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.portal_feature_ideas IS
  'Feature ideas written by portal clients (invoicing hub box). Staff read them in Portal Chats > Idea request; handled_at set when staff tick one off. Server-only access.';
