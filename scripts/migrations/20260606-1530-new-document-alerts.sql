-- New-document client alerts (admin -> client)
-- Feature: when staff make a document visible in a client's folder, the client
-- is notified, the Documents sidebar tab pulses, and the doc shows "New" until
-- that person opens it. See docs/systems/documents.md + portal.md.
--
-- This migration adds ONLY data structures. Delivery (push/email), the kill
-- switch (app_settings key 'new_document_alert_enabled', default true via
-- getAppSetting fallback — no row needed), and UI live in app code.

-- 1. Per-CONTACT "opened" tracking for client-visible documents.
--    A document is "new" for a contact when there is NO row here for
--    (document_id, contact_id). Correct for multi-owner LLCs: each owner
--    clears their own "new" state independently.
CREATE TABLE IF NOT EXISTS public.portal_document_views (
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  viewed_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_document_views_pkey PRIMARY KEY (document_id, contact_id)
);

-- "Unopened for this contact" lookups go contact-first.
CREATE INDEX IF NOT EXISTS idx_portal_document_views_contact
  ON public.portal_document_views (contact_id);

-- 2. Per-document notify controls.
--    notify_client      — staff toggle at upload (default true); set false to
--                         add a document quietly with no client alert.
--    client_notified_at — set once the new-document alert has fired for this
--                         doc. Doubles as the BASELINE: existing rows keep NULL,
--                         so pre-feature documents never show as "new" and no
--                         day-one flood occurs. No backfill required.
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS notify_client boolean NOT NULL DEFAULT true;
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS client_notified_at timestamptz;

-- Partial index for the sidebar "unopened count" query: only client-visible,
-- already-notified documents are candidates for the "New" state.
CREATE INDEX IF NOT EXISTS idx_documents_client_notified
  ON public.documents (account_id, client_notified_at)
  WHERE portal_visible = true AND client_notified_at IS NOT NULL;
