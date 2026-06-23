-- Formation Name Command Center — per-name status tracking on the SD.
--
-- The "Wizard Submitted" stage drives the whole LLC-name process: staff check
-- each candidate on the Secretary of State, send the available one(s) to the
-- client for approval (a Client Decision Request behind the scenes), file the
-- accepted name, and handle SOS rejections. Each name carries a status; new
-- names the client proposes (via a text_input decision response) append to the
-- same array.
--
-- Shape (jsonb array):
--   [{ "name": "Automatiko LLC", "source": "wizard"|"client_resubmit",
--      "field": "llc_name_1", "status": "pending", "updated_at": null,
--      "decision_request_id": null, "sos_result": null }]
-- status ∈ pending | available | not_available | sent_to_client | accepted
--          | rejected_by_client | filed | rejected_by_sos
--
-- Additive, idempotent. Apply to SANDBOX via
--   node scripts/apply-migration.js scripts/migrations/20260618-name-checks.sql
-- then promote via execute_sql(reason:"migration:20260618-name-checks.sql"). R105.

ALTER TABLE service_deliveries
  ADD COLUMN IF NOT EXISTS name_checks jsonb;
