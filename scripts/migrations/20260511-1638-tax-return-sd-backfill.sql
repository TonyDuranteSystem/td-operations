-- Phase 3 (SD Pipeline) — backfill service_deliveries for tax_returns rows
-- that lack a matching active Tax Return SD.
--
-- Why: before Phase 3 the Tax Return tab (/tax-returns) wrote tax_returns
-- status directly, never touching service_deliveries. Many existing tax_returns
-- rows therefore have no SD partner, so the SD pipeline (notifications,
-- auto-tasks, stage_history) never fires for them. This backfill pairs each
-- orphan tax_returns row with an SD at the stage that corresponds to its
-- current status. The mapping mirrors lib/operations/tax-return-sd-bridge.ts
-- so future ad-hoc status changes via the tab and this one-shot backfill
-- produce identical SD state.
--
-- Selection predicate: tax_returns rows whose account_id has NO
-- non-cancelled Tax Return SD (covers status NULL too — we still create one
-- at the most permissive entry stage). is_test propagates from accounts so
-- excludeTestRecords keeps working. service_type_entry_id is resolved via
-- a sub-select on catalog_entries so the same SQL works in sandbox and
-- production (the UUID differs across environments).
--
-- Idempotent: re-running is safe — the NOT EXISTS guard skips any tax_returns
-- whose account already has an active SD (including ones created by this
-- migration on a previous run).

INSERT INTO service_deliveries (
  service_type,
  service_name,
  account_id,
  contact_id,
  stage,
  stage_order,
  status,
  start_date,
  assigned_to,
  notes,
  stage_entered_at,
  is_test,
  service_type_entry_id
)
SELECT
  'Tax Return' AS service_type,
  'Tax Return ' || COALESCE(tr.tax_year::text, EXTRACT(YEAR FROM CURRENT_DATE)::text)
    || ' - ' || COALESCE(tr.company_name, 'account ' || tr.account_id::text) AS service_name,
  tr.account_id,
  tr.contact_id,
  CASE COALESCE(tr.status::text, 'Payment Pending')
    WHEN 'Payment Pending'                   THEN 'Company Data Pending'
    WHEN 'Not Invoiced'                      THEN 'Company Data Pending'
    WHEN 'Paid - Not Started'                THEN 'Paid - Awaiting Data'
    WHEN 'Activated - Need Link'             THEN 'Paid - Awaiting Data'
    WHEN 'Link Sent - Awaiting Data'         THEN 'Paid - Awaiting Data'
    WHEN 'Extension Requested'               THEN 'Extension Filed'
    WHEN 'Extension Filed'                   THEN 'Extension Filed'
    WHEN 'Data Received'                     THEN 'Data Received'
    WHEN 'Sent to India'                     THEN 'Preparation'
    WHEN 'TR Completed - Awaiting Signature' THEN 'TR Completed'
    WHEN 'TR Filed'                          THEN 'TR Filed'
    ELSE 'Company Data Pending'
  END AS stage,
  CASE COALESCE(tr.status::text, 'Payment Pending')
    WHEN 'Payment Pending'                   THEN -1
    WHEN 'Not Invoiced'                      THEN -1
    WHEN 'Paid - Not Started'                THEN 0
    WHEN 'Activated - Need Link'             THEN 0
    WHEN 'Link Sent - Awaiting Data'         THEN 0
    WHEN 'Extension Requested'               THEN 2
    WHEN 'Extension Filed'                   THEN 2
    WHEN 'Data Received'                     THEN 3
    WHEN 'Sent to India'                     THEN 5
    WHEN 'TR Completed - Awaiting Signature' THEN 6
    WHEN 'TR Filed'                          THEN 7
    ELSE -1
  END AS stage_order,
  'active' AS status,
  CURRENT_DATE AS start_date,
  'Luca' AS assigned_to,
  'Auto-created by Phase 3 SD-pipeline backfill (migration 20260511-1638). '
    || 'Original tax_returns.status="' || COALESCE(tr.status::text, '<null>') || '".' AS notes,
  NOW() AS stage_entered_at,
  COALESCE(a.is_test, FALSE) AS is_test,
  (SELECT id FROM catalog_entries WHERE catalog_id = 'services' AND slug = 'tax_return' LIMIT 1) AS service_type_entry_id
FROM tax_returns tr
LEFT JOIN accounts a ON a.id = tr.account_id
WHERE NOT EXISTS (
  SELECT 1
  FROM service_deliveries sd
  WHERE sd.account_id = tr.account_id
    AND sd.service_type = 'Tax Return'
    AND sd.status <> 'cancelled'
);
