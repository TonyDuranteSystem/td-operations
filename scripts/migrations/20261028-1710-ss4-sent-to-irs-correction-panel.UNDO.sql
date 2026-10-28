UPDATE pipeline_stages
SET stage_layout = jsonb_set(
  stage_layout, '{components}',
  (SELECT COALESCE(jsonb_agg(c ORDER BY ord), '[]'::jsonb)
   FROM jsonb_array_elements(stage_layout->'components') WITH ORDINALITY AS t(c, ord)
   WHERE c->>'type' <> 'ss4_correction_panel')
)
WHERE service_type = 'Company Formation' AND stage_name = 'SS-4 Sent to IRS';
