-- Team Workspace — internal tables must exclude PARTNERS, not just clients.
--
-- Antonio 2026-07-24, verbatim: "I don't care about Chris, and the client's
-- browser never has to get anything about our business."
--
-- Every internal_* table's RLS predicate was `role <> 'client'` — the exact rule
-- that let a managed partner be treated as staff in the directory on
-- 2026-07-22, the same mistake one layer down. A partner (Cris authenticates
-- with app_metadata.role='partner') could SELECT every internal team message
-- body with their own JWT, including through a realtime subscription — and the
-- dashboard's notification listener opens exactly such a subscription with NO
-- server-side filter.
--
-- What was actually stopping him, neither of which is an access control:
--   1. middleware confines /collab users away from the dashboard, and
--   2. the listener happens to be mounted in the dashboard layout, which
--      /collab is not inside.
-- The new "every work channel pops up a toast" rule leaned on those two
-- accidents. This makes the database state the rule instead.
--
-- ⚠️ DENY-LIST, deliberately — the SAME shape as isStaffAuthRole in
-- lib/team/workspace.ts, so the DB and the code state one rule, not two:
--   * an absent/unknown role still counts as staff, preserving access for legacy
--     staff accounts created before the role field existed (a strict allow-list
--     would lock them out — a different outage);
--   * adding any FUTURE non-employee role ('contractor', 'auditor') MUST add it
--     here AND to NON_STAFF_AUTH_ROLES in the same change.
--
-- Server-side code is unaffected: every internal_* write goes through the
-- service-role client, which bypasses RLS entirely. Staff (admin / team /
-- unset) keep exactly the access they had.
--
-- lower(): isStaffAuthRole lowercases the claim before comparing, so without it
-- a role stored as 'Partner' would be refused by the code and ALLOWED by the
-- database — two statements of "one rule" that disagree, which is precisely the
-- drift this migration exists to remove.
--
-- ALTER POLICY, not DROP+CREATE, on purpose: it rewrites the predicate in place
-- with no window in which the table has no policy at all. This is the exact form
-- applied to sandbox on 2026-07-24.

ALTER POLICY internal_messages_staff_all ON public.internal_messages
  USING      (lower(COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '')) NOT IN ('client','partner'))
  WITH CHECK (lower(COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '')) NOT IN ('client','partner'));

ALTER POLICY internal_threads_staff_all ON public.internal_threads
  USING      (lower(COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '')) NOT IN ('client','partner'))
  WITH CHECK (lower(COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '')) NOT IN ('client','partner'));

ALTER POLICY internal_thread_reads_staff_all ON public.internal_thread_reads
  USING      (lower(COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '')) NOT IN ('client','partner'))
  WITH CHECK (lower(COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '')) NOT IN ('client','partner'));

ALTER POLICY internal_thread_state_staff_all ON public.internal_thread_state
  USING      (lower(COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '')) NOT IN ('client','partner'))
  WITH CHECK (lower(COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '')) NOT IN ('client','partner'));

ALTER POLICY internal_root_reads_staff_all ON public.internal_root_reads
  USING      (lower(COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '')) NOT IN ('client','partner'))
  WITH CHECK (lower(COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '')) NOT IN ('client','partner'));

ALTER POLICY internal_root_follows_staff_all ON public.internal_root_follows
  USING      (lower(COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '')) NOT IN ('client','partner'))
  WITH CHECK (lower(COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '')) NOT IN ('client','partner'));

ALTER POLICY internal_root_later_staff_all ON public.internal_root_later
  USING      (lower(COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '')) NOT IN ('client','partner'))
  WITH CHECK (lower(COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '')) NOT IN ('client','partner'));

-- internal_thread_later already excluded partners (it was created after the
-- 2026-07-22 directory fix) but was still case-SENSITIVE, and its policy is
-- named ..._staff, not ..._staff_all — the one name that breaks the pattern.
ALTER POLICY internal_thread_later_staff ON public.internal_thread_later
  USING      (lower(COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '')) NOT IN ('client','partner'))
  WITH CHECK (lower(COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '')) NOT IN ('client','partner'));
