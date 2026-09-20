-- 2026-09-20 — Security: close the last anonymous WRITE hole on lease_agreements.
--
-- app/lease/[token]/page.tsx and app/lease/[token]/[code]/page.tsx wrote the
-- final "signed" status (and the admin "regenerate PDF" action) directly with
-- the anon key: `supabasePublic.from('lease_agreements').update(...)`. Anyone
-- holding the public anon key could set ANY lease's status to "signed" with an
-- arbitrary pdf_storage_path, with no real signing ever having happened.
--
-- SELECT was already revoked from anon on 2026-07-24
-- (20260724-1900-lease-close-public-read.sql) — the read side of this table
-- has been server-verified since then via /api/lease/[token]/fetch. This
-- migration closes the remaining anon UPDATE, now that both write paths
-- (sign, admin regen) go through new server routes
-- (/api/lease/[token]/{sign,regen}) that verify the access code (or, for
-- regen, a real staff session) themselves with the service role.
--
-- The lease_row_id_visible_to_anon_for_signing SELECT policy is untouched —
-- it is already scoped to a column-level grant on `id` only (the same pattern
-- used for the Operating Agreement), not a real read hole.

DROP POLICY IF EXISTS "anon_update_lease" ON public.lease_agreements;
REVOKE UPDATE ON public.lease_agreements FROM anon;
REVOKE UPDATE ON public.lease_agreements FROM PUBLIC;
