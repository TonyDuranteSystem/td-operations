-- Slice 9 (Tax Submission Review Workflow REV 4.1): RA Renewal + Annual Report
-- → To-Do board cards.
--
-- Two new action_events catalog rows so the ra-renewal-check /
-- annual-report-check crons can emit a staff To-Do card (message_actions)
-- via emitActionNeeded instead of an old-style tasks row. Mirrors the
-- existing action_events rows (scope / next_step / default_assignee).
--
-- Idempotent: ON CONFLICT (catalog_id, slug) DO NOTHING.

INSERT INTO public.catalog_entries (catalog_id, slug, display_name, status, metadata)
VALUES
  (
    'action_events',
    'ra_renewal_upcoming',
    'RA renewal upcoming',
    'active',
    '{"scope":"account","next_step":"Renew RA on Harbor Compliance","default_assignee":"Luca"}'::jsonb
  ),
  (
    'action_events',
    'annual_report_upcoming',
    'Annual report upcoming',
    'active',
    '{"scope":"account","next_step":"File Annual Report on state portal","default_assignee":"Luca"}'::jsonb
  )
ON CONFLICT (catalog_id, slug) DO NOTHING;
