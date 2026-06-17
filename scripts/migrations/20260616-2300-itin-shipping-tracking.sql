-- ITIN shipping tracking — client submits courier + tracking number for the
-- signed ITIN package they mail to the TD office (Client Signing stage).
--
-- Storage: three nullable columns on service_deliveries (no existing JSONB
-- "details" column; two scalar values + a submission timestamp are cleaner and
-- queryable than packing them into stage_history/notes).
--
-- Also adds a `shipping_info` component to the ITIN "Client Signing" stage_layout
-- so the staff workspace surfaces what the client entered.

ALTER TABLE service_deliveries
  ADD COLUMN IF NOT EXISTS shipping_courier text,
  ADD COLUMN IF NOT EXISTS shipping_tracking_number text,
  ADD COLUMN IF NOT EXISTS shipping_submitted_at timestamptz;

-- Insert a shipping_info component into the ITIN "Client Signing" stage layout.
-- Current order (verified sandbox 2026-06-16): waiting_notice(1), document_viewer(2),
-- chat(3), action_buttons(4). Insert at fractional position 2.5 so it lands right
-- after document_viewer, before chat. WITH ORDINALITY + jsonb_agg(... ORDER BY)
-- guarantees deterministic order (a plain UNION ALL would not). Idempotent: skips
-- if a shipping_info component is already present.
UPDATE pipeline_stages ps
SET stage_layout = jsonb_set(
  ps.stage_layout,
  '{components}',
  (
    SELECT jsonb_agg(elem ORDER BY ord)
    FROM (
      SELECT elem, ord::numeric AS ord
      FROM jsonb_array_elements(ps.stage_layout->'components') WITH ORDINALITY AS t(elem, ord)
      UNION ALL
      SELECT '{"type":"shipping_info"}'::jsonb, 2.5
    ) s
  )
)
WHERE ps.service_type = 'ITIN'
  AND ps.stage_name = 'Client Signing'
  AND NOT (ps.stage_layout->'components' @> '[{"type":"shipping_info"}]');
