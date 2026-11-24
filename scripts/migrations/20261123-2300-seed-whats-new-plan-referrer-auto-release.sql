-- migration:20261123-2300-seed-whats-new-plan-referrer-auto-release.sql
--
-- What's New catalog rows for the two new chat-event kinds the automatic referrer-reward release writes
-- (lib/portal/chat-events.ts, dev job e71d786c): plan_referrer_auto_released (staff FYI) and
-- plan_referrer_auto_release_failed (staff action). Data only, no schema change. Without these rows the notes
-- still show (unregistered keys default visible — app/api/crm/admin-actions/whats-new/route.ts), just without a
-- friendly label or an on/off toggle in Board Settings.
--
-- Idempotent (a row that already exists is left alone). Written as INSERT ... WHERE NOT EXISTS rather than
-- ON CONFLICT DO UPDATE on purpose: the execute_sql safety check reads "DO UPDATE SET" as an UPDATE with no WHERE
-- and refuses it, which would block promoting this file to production.

INSERT INTO catalog_entries (catalog_id, slug, display_name, status, metadata)
SELECT v.catalog_id, v.slug, v.display_name, 'active', v.metadata::jsonb
FROM (VALUES
  ('whats_new_events', 'plan_referrer_auto_released',        'Referral reward issued automatically',               '{"visible":true,"order":26}'),
  ('whats_new_events', 'plan_referrer_auto_release_failed',  'Referral reward could not be issued automatically',  '{"visible":true,"order":27}')
) AS v(catalog_id, slug, display_name, metadata)
WHERE NOT EXISTS (
  SELECT 1 FROM catalog_entries c WHERE c.catalog_id = v.catalog_id AND c.slug = v.slug
);
