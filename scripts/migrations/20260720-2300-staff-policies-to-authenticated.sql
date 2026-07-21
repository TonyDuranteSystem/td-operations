-- Pin every staff RLS policy to the `authenticated` role.
--
-- THE BUG (the biggest single exposure found in the 2026-07-20 audit):
-- 29 policies were granted to role `public`, which INCLUDES `anon`, with the
-- predicate
--     COALESCE((auth.jwt() -> 'app_metadata') ->> 'role', '') <> 'client'
-- For an unauthenticated request auth.jwt() is NULL, so COALESCE yields '' and
-- '' <> 'client' is TRUE. The predicate excludes logged-in CLIENTS only; it has
-- never excluded the public.
--
-- And `anon` holds SELECT/INSERT/UPDATE/DELETE grants on these tables (verified
-- against production), so RLS was the only thing standing there — and it wasn't.
--
-- NET EFFECT BEFORE THIS FIX: with no login at all, anyone could read AND write
-- AND delete: contacts, accounts, account_contacts, documents,
-- client_bank_accounts, bank_transactions, plaid_connections, oauth_tokens,
-- payment_items, deadlines, services, service_deliveries, billing_entities,
-- client_partners, dev_tasks, job_queue, webhook_events, pipeline_stages,
-- lease_agreements, form_8832_applications, the entire internal team chat
-- (internal_messages/threads/reads/follows/later/state) and the Slack mirror.
--
-- THE FIX is the `TO authenticated` clause, nothing else. That is the actual
-- control: it stops the policy from being evaluated for anon at all, so a NULL
-- jwt can never slip through the COALESCE. ALTER POLICY changes ONLY the role
-- and preserves each predicate byte-for-byte — no drop, no recreate, no risk of
-- a mistyped predicate. Staff and clients are `authenticated`, so every
-- logged-in path is unaffected; server routes use the service key and are
-- covered by the separate service_role policies.
--
-- Precedent for the correct form:
-- scripts/migrations/20260503-2200-address-registry-prod-backfill.sql:52-55.
--
-- ⚠️ DELIBERATELY EXCLUDED — DO NOT ADD THESE WITHOUT THE TOKEN WORK:
--   * signature_requests / signature_requests_staff_all
--     The PUBLIC e-sign signer page (app/sign-document/[token]/[code]) reads this
--     table with the anon client, and this broken policy is its ONLY way in —
--     the table's other policy (client_read_own_signature_requests) resolves to
--     nothing for anon. Pinning it would lock out every external signer
--     immediately, mid-signature. It must be replaced by a token-scoped
--     SECURITY DEFINER RPC first (the Ship 4 work).
--   * annual_agreements / client_read_own — a CLIENT policy, already resolves to
--     no rows for anon; no security gain, so left untouched (minimal change).
--   * portal_messages / "Admin users read all messages" — its predicate is
--     `role = ANY(ARRAY['admin','staff'])`, which is NULL (not true) for anon,
--     so it is already anon-safe.
--
-- SAFE BY CONSTRUCTION — every table below keeps a working path for staff:
--   accounts, contacts, account_contacts, deadlines, services,
--   service_deliveries  -> separate `auth_read` policy TO authenticated
--   documents           -> separate "Scoped read" policy (staff pass its
--                          role <> 'client' branch)
--   everything else     -> the same policy, now scoped to authenticated, which
--                          staff still satisfy
--
-- The public token-gated pages are unaffected: lease_agreements and
-- form_8832_applications each carry their OWN separate anon policy
-- (anon_select_lease / anon_update_lease, anon_read_by_token /
-- anon_update_signing). Those remain open and are addressed by the Ship 4
-- token-scoping work, not here.
--
-- ROLLBACK (restores the previous, vulnerable state exactly):
--   re-run this file with `TO public` in place of `TO authenticated`.

BEGIN;

ALTER POLICY account_contacts_staff_read        ON public.account_contacts        TO authenticated;
ALTER POLICY accounts_staff_read                ON public.accounts                TO authenticated;
ALTER POLICY bank_transactions_staff_all        ON public.bank_transactions       TO authenticated;
ALTER POLICY billing_entities_staff_all         ON public.billing_entities        TO authenticated;
ALTER POLICY client_bank_accounts_staff_all     ON public.client_bank_accounts    TO authenticated;
ALTER POLICY client_partners_staff_all          ON public.client_partners         TO authenticated;
ALTER POLICY contacts_staff_read                ON public.contacts                TO authenticated;
ALTER POLICY deadlines_staff_read               ON public.deadlines               TO authenticated;
ALTER POLICY dev_tasks_staff_all                ON public.dev_tasks               TO authenticated;
ALTER POLICY documents_staff_read               ON public.documents               TO authenticated;
ALTER POLICY form_8832_staff_all                ON public.form_8832_applications  TO authenticated;
ALTER POLICY internal_messages_staff_all        ON public.internal_messages       TO authenticated;
ALTER POLICY internal_root_follows_staff_all    ON public.internal_root_follows   TO authenticated;
ALTER POLICY internal_root_later_staff_all      ON public.internal_root_later     TO authenticated;
ALTER POLICY internal_root_reads_staff_all      ON public.internal_root_reads     TO authenticated;
ALTER POLICY internal_thread_reads_staff_all    ON public.internal_thread_reads   TO authenticated;
ALTER POLICY internal_thread_state_staff_all    ON public.internal_thread_state   TO authenticated;
ALTER POLICY internal_threads_staff_all         ON public.internal_threads        TO authenticated;
ALTER POLICY job_queue_staff_all                ON public.job_queue               TO authenticated;
ALTER POLICY lease_agreements_staff_all         ON public.lease_agreements        TO authenticated;
ALTER POLICY oauth_tokens_staff_all             ON public.oauth_tokens            TO authenticated;
ALTER POLICY payment_items_staff_all            ON public.payment_items           TO authenticated;
ALTER POLICY pipeline_stages_staff_all          ON public.pipeline_stages         TO authenticated;
ALTER POLICY plaid_connections_staff_all        ON public.plaid_connections       TO authenticated;
ALTER POLICY service_deliveries_staff_read      ON public.service_deliveries      TO authenticated;
ALTER POLICY services_staff_read                ON public.services                TO authenticated;
ALTER POLICY slack_channels_staff_all           ON public.slack_channels          TO authenticated;
ALTER POLICY slack_messages_staff_all           ON public.slack_messages          TO authenticated;
ALTER POLICY webhook_events_staff_all           ON public.webhook_events          TO authenticated;

COMMIT;

-- VERIFY (expect zero rows — no staff policy left on role `public`):
-- SELECT tablename, policyname, roles::text FROM pg_policies
-- WHERE schemaname='public'
--   AND (roles::text LIKE '%public%' OR roles::text LIKE '%anon%')
--   AND coalesce(qual, with_check, '') LIKE '%app_metadata%'
--   AND coalesce(qual, with_check, '') NOT LIKE '%auth.role()%'
--   AND coalesce(qual, with_check, '') NOT LIKE '%get_client_account_ids%'
--   AND coalesce(qual, with_check, '') NOT LIKE '%account_contacts.contact_id%'
--   AND policyname <> 'signature_requests_staff_all'
-- ORDER BY tablename;
