-- Flow chat: scope portal_messages to a specific service_delivery (flow).
--
-- The flow Workspace chat panel (components/flows/flow-chat.tsx) fetches and
-- sends messages tied to ONE service_delivery rather than to the account's
-- whole portal thread. Mirrors the precedent set by
-- signature_requests.service_delivery_id (20260614-1500). Nullable so every
-- existing portal_messages row (account/contact-scoped client chat) is
-- untouched; partial index keeps the flow-scoped lookup fast without bloating
-- the index for the NULL-majority client-chat rows.

ALTER TABLE portal_messages
  ADD COLUMN IF NOT EXISTS service_delivery_id uuid REFERENCES service_deliveries(id);

CREATE INDEX IF NOT EXISTS idx_portal_messages_service_delivery
  ON portal_messages(service_delivery_id, created_at)
  WHERE service_delivery_id IS NOT NULL;
