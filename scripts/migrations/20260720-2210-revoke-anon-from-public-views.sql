-- Revoke unauthenticated (anon) access to every view in the public schema.
--
-- WHY (2026-07-20, council pass on Ship 2, dev job 023c7d06):
-- All 15 views in `public` are owned by `postgres`, which carries rolbypassrls,
-- and none set `security_invoker`. A non-security_invoker view executes with its
-- OWNER's rights, so RLS on the underlying tables DOES NOT APPLY. `anon` holds
-- SELECT on all 15. Net effect: one unauthenticated PostgREST request against
-- v_client_full returns itin_number / citizenship / residency / kyc_status /
-- email / phone for EVERY contact; v_account_detail returns EIN + banking;
-- v_overdue_payments returns contact emails + amounts; v_tax_return_tracker the
-- whole tax book. No token, no guessing, no row limit.
--
-- This is the largest single exposure found in the Ship 2 investigation and it
-- was absent from the original plan entirely.
--
-- WHY THIS IS SAFE (verified 2026-07-20 before applying):
--   * REVOKE targets ONLY the `anon` role. Staff and portal users authenticate
--     and act as `authenticated`; server routes use the service key and act as
--     `service_role`. Neither is touched, so no logged-in path can break.
--   * grep across app/ lib/ components/ shows 11 of the 15 views are referenced
--     ONLY in lib/database.types.ts (generated types) — nothing queries them.
--     The 4 with real consumers are all server-side:
--       v_messaging_inbox  -> app/(dashboard)/layout.tsx, lib/mcp/tools/messaging.ts
--       service_catalog    -> app/api/service-catalog/route.ts,
--                             app/api/crm/admin-actions/create-service/route.ts,
--                             app/(dashboard)/service-catalog/actions.ts
--   * ZERO public (token-gated) pages and ZERO portal pages reference any view.
--
-- NOT a complete fix for the view layer: security_invoker stays off, so an
-- AUTHENTICATED caller still bypasses RLS through these views. That is a
-- separate change (a client-role portal user could otherwise read other
-- clients' rows) and is tracked as follow-up work — it needs each view's
-- underlying-table policies checked first so staff reads don't break.
-- This migration closes the unauthenticated hole, which is the urgent one.
--
-- ROLLBACK (restores the previous state exactly):
--   GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
--   -- (or per-view: GRANT SELECT ON public.<view> TO anon;)

BEGIN;

REVOKE SELECT ON public.service_catalog                          FROM anon;
REVOKE SELECT ON public.v_account_detail                         FROM anon;
REVOKE SELECT ON public.v_active_service_deliveries              FROM anon;
REVOKE SELECT ON public.v_active_tasks                           FROM anon;
REVOKE SELECT ON public.v_client_full                            FROM anon;
REVOKE SELECT ON public.v_client_timeline                        FROM anon;
REVOKE SELECT ON public.v_messaging_inbox                        FROM anon;
REVOKE SELECT ON public.v_new_messages                           FROM anon;
REVOKE SELECT ON public.v_overdue_payments                       FROM anon;
REVOKE SELECT ON public.v_pipeline_summary                       FROM anon;
REVOKE SELECT ON public.v_sd_pipeline_summary                    FROM anon;
REVOKE SELECT ON public.v_sla_monitor                            FROM anon;
REVOKE SELECT ON public.v_sla_summary                            FROM anon;
REVOKE SELECT ON public.v_tax_return_data_received_anomalies     FROM anon;
REVOKE SELECT ON public.v_tax_return_tracker                     FROM anon;

COMMIT;

-- VERIFY (expect anon_can_select = false for all 15):
-- SELECT c.relname, has_table_privilege('anon', c.oid, 'SELECT') AS anon_can_select
-- FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
-- WHERE n.nspname = 'public' AND c.relkind = 'v' ORDER BY c.relname;
