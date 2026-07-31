-- 2026-07-31 — Close the 15 public views to anon and authenticated.
--
-- ⚠️ ALREADY APPLIED TO PRODUCTION on 2026-07-31 by Antonio, by hand, in the
--    Supabase SQL editor. This file is the RECORD of what was run, not a pending
--    change. Do NOT re-apply. It is here so the next session does not rediscover
--    any of this from scratch.
--
-- ══ WHY ════════════════════════════════════════════════════════════════════════
-- All 15 views in schema `public` are owner=postgres with security_invoker OFF,
-- so they execute with the OWNER's rights and bypass RLS on their base tables.
--
--   1. ANONYMOUS WRITE CHANNEL. `anon` held INSERT/UPDATE/DELETE/TRUNCATE/
--      REFERENCES/TRIGGER on all 15. `v_account_detail` is auto-updatable
--      (information_schema.views.is_updatable = YES, 33 columns over
--      public.accounts) and `service_catalog` is INSTEAD OF-trigger writable
--      (service_catalog_iud_trg -> catalog_entries / pipeline_stages).
--      => an unauthenticated PATCH with the publishable anon key rewrote the
--         ACCOUNT MASTER TABLE and the pricing catalogue, bypassing RLS.
--      The anon key is NEXT_PUBLIC and ships in the browser bundle of every
--      public offer/form/signing page (lib/supabase/public-client.ts), so this
--      was reachable by anyone holding a client link — not just staff.
--
--   2. CROSS-TENANT READ. `authenticated` held SELECT on all 15. That role is
--      every portal login — 272 auth.users rows carry app_metadata.role='client'
--      (192 active within 90 days). v_client_full = 505 rows exposing
--      itin_number / citizenship / residency / kyc_status / email / phone / EIN;
--      v_account_detail = 328 rows; plus v_overdue_payments and
--      v_tax_return_tracker.
--
-- This FINISHES the job that 20260720-2210-revoke-anon-from-public-views.sql
-- started. That migration revoked SELECT from `anon` ONLY, and left every write
-- privilege and all of `authenticated` in place — its own comments (lines 29-34)
-- flagged the remainder as unfinished follow-up. It was never picked up.
--
-- ══ WHY IT WAS SAFE ════════════════════════════════════════════════════════════
-- Verified on production immediately before applying:
--   * All 16 code call sites on these views use the SERVICE key (supabaseAdmin),
--     checked call-by-call, not file-by-file:
--       app/api/service-catalog/route.ts:26,78,88,123,158
--       app/api/crm/admin-actions/create-service/route.ts:27
--       app/(dashboard)/layout.tsx:71
--       app/(dashboard)/service-catalog/actions.ts:230,259,272,285,293,472
--       lib/mcp/tools/messaging.ts:32
--     Zero browser-side readers, zero portal pages, zero raw /rest/v1 fetches.
--     12 of the 15 views have no application reader at all.
--   * ROLE INHERITANCE (pg_auth_members): only `authenticator` (rolinherit=false
--     — it SETs ROLE, it does not inherit) and `postgres` (superuser) are members
--     of anon/authenticated. service_role, ai_readonly and audit_readonly are
--     INDEPENDENT, so this could not strip the server or the AI worker.
--   * COLUMN-LEVEL GRANTS: pg_attribute.attacl is NULL on all 247 view columns,
--     so a table-level REVOKE fully closes it and has_table_privilege does not
--     lie afterwards. NOTE the trap: information_schema.column_privileges
--     reported 1729 rows for anon+authenticated — that is NOT 1729 separate
--     grants, it is 247 columns x 7 role/privilege combinations, i.e. table-level
--     privileges expanded per column. Use pg_attribute.attacl to ask the real
--     question.
--
-- ══ DELIBERATELY OMITTED ═══════════════════════════════════════════════════════
-- ALTER VIEW ... SET (security_invoker = on) was drafted and then DROPPED.
-- On a view whose base tables have no policy for `authenticated`, invoker mode
-- returns ZERO ROWS SILENTLY instead of erroring. Verified candidates for that
-- failure: v_client_timeline (client_interactions has a service_role-only
-- policy) and v_messaging_inbox / v_new_messages (the three messaging tables
-- have only service_role_all). This subsystem has no automated tests, and a
-- silent-empty failure mode is precisely the class this whole job exists to
-- remove. The REVOKE alone closes the hole; invoker mode was belt-and-braces.
-- If it is ever revisited: service_catalog must be EXCLUDED (INSTEAD OF trigger
-- view whose base table has RLS off), and v_sla_summary + v_sla_monitor must be
-- set together (nested view — outer-only leaves the inner running as owner).
--
-- ══ RESIDUAL, ACCEPTED ═════════════════════════════════════════════════════════
-- Six roles still read these views with RLS bypassed: service_role, ai_readonly,
-- audit_readonly, postgres, supabase_read_only_user, supabase_etl_admin. None is
-- reachable from a browser or a user JWT. A leaked service key still reads
-- everything through them — unchanged by this migration, and true of the base
-- tables anyway.


-- ══ PRE-FLIGHT (read-only) — run before, and again after ═══════════════════════
-- STOP CONDITIONS, both of which earned their place: on 2026-07-31 the first run
-- returned 2 rows with anon_sel=true, because the editor was pointed at the
-- SANDBOX project. The row-count check caught it before the apply.
--   * must return EXACTLY 15 rows, and the names must match the REVOKE list
--   * if anon_sel is TRUE anywhere -> STOP, the 20260720-2210 revoke was undone
SELECT c.relname,
       has_table_privilege('anon',          c.oid,'SELECT') AS anon_sel,
       has_table_privilege('anon',          c.oid,'UPDATE') AS anon_upd,
       has_table_privilege('authenticated', c.oid,'SELECT') AS auth_sel,
       has_table_privilege('service_role',  c.oid,'SELECT') AS svc_sel,
       has_table_privilege('service_role',  c.oid,'INSERT') AS svc_ins,
       has_table_privilege('service_role',  c.oid,'UPDATE') AS svc_upd,
       has_table_privilege('service_role',  c.oid,'DELETE') AS svc_del,
       has_table_privilege('ai_readonly',   c.oid,'SELECT') AS ai_sel
FROM pg_class c
WHERE c.relnamespace='public'::regnamespace AND c.relkind='v'
ORDER BY c.relname;
-- BEFORE (recorded 2026-07-31): anon_sel=false, anon_upd=true, auth_sel=true,
--                               svc_*=true, ai_sel=true  — on all 15.
-- AFTER  (recorded 2026-07-31): anon_sel=false, anon_upd=FALSE, auth_sel=FALSE,
--                               svc_*=true, ai_sel=true  — on all 15.

SELECT count(*) AS column_level_grants_expect_zero
FROM pg_class c
JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
WHERE c.relnamespace='public'::regnamespace AND c.relkind='v' AND a.attacl IS NOT NULL;
-- Returned 0 before applying. If ever non-zero, a table-level REVOKE is not enough.


-- ══ WHAT WAS RUN ═══════════════════════════════════════════════════════════════
BEGIN;
SET LOCAL lock_timeout = '5s';

REVOKE ALL ON
  public.service_catalog,
  public.v_account_detail,
  public.v_active_service_deliveries,
  public.v_active_tasks,
  public.v_client_full,
  public.v_client_timeline,
  public.v_messaging_inbox,
  public.v_new_messages,
  public.v_overdue_payments,
  public.v_pipeline_summary,
  public.v_sd_pipeline_summary,
  public.v_sla_monitor,
  public.v_sla_summary,
  public.v_tax_return_data_received_anomalies,
  public.v_tax_return_tracker
FROM anon, authenticated;

COMMIT;


-- ══ POST-APPLY VERIFICATION ACTUALLY PERFORMED (2026-07-31) ════════════════════
--  * Pre-flight re-run, both by Antonio and independently: anon 0/15 with any of
--    SELECT/UPDATE/INSERT/DELETE; authenticated 0/15 readable; service_role
--    15/15 with SELECT+UPDATE; ai_readonly 15/15 readable.
--  * msg_inbox (MCP, live production server, service key) returned real
--    Telegram/WhatsApp groups with unread counts — this reads v_messaging_inbox
--    through the real server path. Working.
--  * crm_dashboard_stats returned a complete snapshot (327 accounts, 626
--    payments, 146 deals, all pipelines).
--  * SELECT count(*) FROM service_catalog -> 21 rows, 19 active.
--  * Zero rows in system_errors within the 2h window after apply.
--  * /api/health 200; portal.tonydurante.us and app.tonydurante.us 307-to-login.
--  * Antonio loaded /service-catalog in the CRM: "Service Catalog — 19 services"
--    rendered with the full list.
--  * FALSE ALARM cleared: crm_dashboard_stats prints "Services (0)". That reads
--    the legacy `services` table, which is genuinely empty (0 rows) and is
--    superseded by the catalog. service_deliveries intact at 1693. Not caused
--    by this change.


-- ══ HOW TO UNDO ════════════════════════════════════════════════════════════════
-- Uncomment the four lines, highlight them, Run. Restores EXACTLY the prior state.
--
-- ⚠️ `GRANT ALL ... TO anon, authenticated` is NOT a rollback. `anon` did NOT hold
--    SELECT before this migration (revoked 2026-07-20) — granting ALL to both
--    would hand anon read access back and silently undo that earlier fix.
--    The undo below is asymmetric on purpose: GRANT ALL to both, then REVOKE
--    SELECT from anon. That form is also version-proof (PG17 here — an enumerated
--    six-privilege list would miss MAINTAIN).
--
-- BEGIN;
-- GRANT ALL ON public.service_catalog, public.v_account_detail, public.v_active_service_deliveries, public.v_active_tasks, public.v_client_full, public.v_client_timeline, public.v_messaging_inbox, public.v_new_messages, public.v_overdue_payments, public.v_pipeline_summary, public.v_sd_pipeline_summary, public.v_sla_monitor, public.v_sla_summary, public.v_tax_return_data_received_anomalies, public.v_tax_return_tracker TO anon, authenticated;
-- REVOKE SELECT ON public.service_catalog, public.v_account_detail, public.v_active_service_deliveries, public.v_active_tasks, public.v_client_full, public.v_client_timeline, public.v_messaging_inbox, public.v_new_messages, public.v_overdue_payments, public.v_pipeline_summary, public.v_sd_pipeline_summary, public.v_sla_monitor, public.v_sla_summary, public.v_tax_return_data_received_anomalies, public.v_tax_return_tracker FROM anon;
-- COMMIT;


-- ══ DURABILITY WARNING ═════════════════════════════════════════════════════════
-- These grants come back BY THEMSELVES if a view is recreated. Schema `public`
-- default privileges grant anon/authenticated on new objects, from TWO grantors
-- (postgres and supabase_admin) across tables, sequences and functions — and
-- supabase_admin also has defaults on graphql, graphql_public and
-- supabase_functions. Precedent: 20260610-1200-phase2-drop-india-columns.sql:30-31
-- DROPs and recreates v_tax_return_tracker and v_tax_return_data_received_anomalies.
-- ANY future migration of that shape silently reopens the view it recreates.
-- => re-run the pre-flight after any migration that touches a view definition,
--    and fix the default privileges (tracked on dev job 023c7d06).
