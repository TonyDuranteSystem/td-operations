-- Tax Return e-signature: link signature requests to a flow (service_delivery),
-- and ensure the signing storage buckets exist (sandbox parity with production).
--
-- Why: an account can have many Tax Return service deliveries across years, so a
-- signature request must be tied to a SPECIFIC service_delivery to (a) show its
-- status on that flow's "Sent for Signature" stage and (b) auto-advance THAT SD
-- to "Signed" when the client signs.

-- 1. Link column (nullable; existing OA/8879/lease requests stay account-scoped).
ALTER TABLE signature_requests
  ADD COLUMN IF NOT EXISTS service_delivery_id uuid REFERENCES service_deliveries(id);

CREATE INDEX IF NOT EXISTS idx_signature_requests_service_delivery
  ON signature_requests(service_delivery_id)
  WHERE service_delivery_id IS NOT NULL;

-- 2. Storage buckets used by the signing pages. Production already has these;
--    sandbox was missing them, so the signing flow could not serve/store PDFs.
INSERT INTO storage.buckets (id, name, public)
VALUES ('signature-requests', 'signature-requests', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('signed-documents', 'signed-documents', false)
ON CONFLICT (id) DO NOTHING;
