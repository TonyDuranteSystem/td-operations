-- MMLLC formation workspace: add the `members_panel` component to the Company
-- Formation stages where staff need to see/override the members and the SS-4
-- Responsible Party (signer): Wizard Submitted (2), Articles Received (4),
-- SS-4 Prepared (5).
--
-- The panel self-hides for SMLLC (its API returns is_mmllc=false), so it is
-- harmless on every Company Formation flow. Each UPDATE is idempotent: the
-- `@>` guard skips the row if members_panel is already present, and the append
-- preserves all existing components untouched.
--
-- Shared-stage note: "Closure" reuses some stage names with formation, so every
-- statement is scoped service_type='Company Formation'.

UPDATE pipeline_stages
SET stage_layout = jsonb_set(
      stage_layout,
      '{components}',
      (stage_layout->'components') || '[{"type":"members_panel"}]'::jsonb
    )
WHERE service_type = 'Company Formation'
  AND stage_name = 'Wizard Submitted'
  AND NOT (stage_layout->'components' @> '[{"type":"members_panel"}]');

UPDATE pipeline_stages
SET stage_layout = jsonb_set(
      stage_layout,
      '{components}',
      (stage_layout->'components') || '[{"type":"members_panel"}]'::jsonb
    )
WHERE service_type = 'Company Formation'
  AND stage_name = 'Articles Received'
  AND NOT (stage_layout->'components' @> '[{"type":"members_panel"}]');

UPDATE pipeline_stages
SET stage_layout = jsonb_set(
      stage_layout,
      '{components}',
      (stage_layout->'components') || '[{"type":"members_panel"}]'::jsonb
    )
WHERE service_type = 'Company Formation'
  AND stage_name = 'SS-4 Prepared'
  AND NOT (stage_layout->'components' @> '[{"type":"members_panel"}]');
