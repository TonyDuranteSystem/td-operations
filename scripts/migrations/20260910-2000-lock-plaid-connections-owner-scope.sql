-- plaid_connections currently grants ALL commands to any `authenticated` (non-client) role
-- with no admin/owner distinction (plaid_connections_staff_all) -- directly reachable via a
-- raw Supabase REST call from any logged-in staff session, bypassing every isAdmin/isOwnerOnly
-- check the Next.js app layer enforces, and exposing live bank access_token values in plaintext.
--
-- Every real caller already uses the service-role client (create-link-token, exchange-token,
-- accounts, webhook, plaid-sync, sync-bank-feeds-now), which bypasses RLS entirely by design --
-- so dropping this policy removes zero legitimate access. With RLS enabled and no policy left,
-- Postgres denies all access to non-bypassing roles by default.
--
-- owner_scoped marks a connection made through My Finances' own connect flow (as opposed to the
-- existing staff-facing Finance page flow) so the shared /api/plaid/accounts listing can exclude
-- it from Finance's Connected Banks display -- the same privacy boundary td_bank_feeds already
-- enforces for 'outgoing'/'owner_ledger' rows, applied here to bank connections themselves.
DROP POLICY IF EXISTS plaid_connections_staff_all ON public.plaid_connections;

ALTER TABLE public.plaid_connections
  ADD COLUMN IF NOT EXISTS owner_scoped boolean NOT NULL DEFAULT false;
