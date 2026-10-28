-- Company Formation "SS-4 Sent to IRS" stage (waiting for the EIN): add the SS-4 correction panel
-- ("Resubmit SS-4…") right under the waiting notice. DML on pipeline_stages (catalog-driven stage layout).
-- Idempotent: only adds the component when it is not already there.
UPDATE pipeline_stages
SET stage_layout = jsonb_set(
  stage_layout,
  '{components}',
  (
    SELECT jsonb_agg(c ORDER BY ord)
    FROM (
      SELECT c, ord FROM jsonb_array_elements(stage_layout->'components') WITH ORDINALITY AS t(c, ord)
      UNION ALL
      SELECT '{"type": "ss4_correction_panel"}'::jsonb, 1.5
    ) x
  )
)
WHERE service_type = 'Company Formation'
  AND stage_name = 'SS-4 Sent to IRS'
  AND NOT (stage_layout->'components') @> '[{"type": "ss4_correction_panel"}]'::jsonb;
