-- dev job a28a0d65: Antonio reported the new "existing client with a new call"
-- banner never shows Luca Gallacci in production, even though his Sep 1 call
-- is correctly stored and linked. Root cause found by comparing his real
-- staff dashboard session against the same data read via service-role
-- (execute_sql) access, which returned the row fine both times.
--
-- call_summaries has row-level security ENABLED but had ZERO policies
-- defined (confirmed via pg_policies on 2026-09-02) — with RLS on and no
-- policy, Postgres denies ALL access to any role without BYPASSRLS. The
-- dashboard's server client authenticates as the ordinary `authenticated`
-- role (lib/supabase/server.ts uses the anon key + user session, not the
-- service role), so every real staff session has always gotten ZERO rows
-- from this table — not just for this new banner, but for the existing
-- "has a call recording" badge on the same Leads page (shipped PR #394,
-- 2026-08-28). It has silently never worked for a real logged-in user; only
-- service-role tools (execute_sql, the MCP server) could ever see it, which
-- is exactly why every earlier verification in this session looked correct.
--
-- Pattern match, not a copy of the leads table's own bare `true` policy:
-- leads.auth_read_leads grants ANY authenticated user (including a client
-- portal login) blanket read access, which is the outlier here — the
-- established convention across the schema (contacts_staff_read,
-- documents_staff_read, deadlines_staff_read, email_tracking_read, etc.,
-- confirmed via pg_policies) is a role check that excludes portal logins.
-- call_summaries holds real client call content (negotiation terms, personal
-- financial detail), so it follows the STRICTER of the two conventions seen
-- in the schema — excluding both 'client' AND 'partner', matching
-- email_tracking_read/email_index_staff_select/action_log rather than the
-- single-exclusion contacts/documents pattern — rather than the leads
-- table's permissive one-off.
--
-- SELECT only: call_summaries rows are written exclusively by the Circleback
-- webhook via the service role (bypasses RLS); there is no staff-facing
-- create/edit UI for this table, so no INSERT/UPDATE policy is needed.
CREATE POLICY call_summaries_staff_read ON call_summaries
  FOR SELECT
  TO authenticated
  USING (
    COALESCE((auth.jwt() -> 'app_metadata' ->> 'role'), '') NOT IN ('client', 'partner')
  );
