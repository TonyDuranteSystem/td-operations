-- OA co-signer signing links: die-on-change + 15-day expiry
-- Dev job 63fae6cb-21f1-4719-a6db-ece4e3307b3a
--
-- Adds three columns to oa_signatures, the per-signer signing record:
--
--   link_expires_at  timestamptz  When the EMAILED signing link stops working.
--                                 NULL = the link was never emailed (a draft the
--                                 client hasn't sent, or a legacy row) → it never
--                                 expires. Stamped now()+15d at every point a
--                                 signer link is emailed. Only the per-signer
--                                 (MMLLC) link expires — the shared access code /
--                                 SMLLC / portal-iframe path is untouched.
--
--   revoked_at       timestamptz  When this signer's credential was killed because
--                                 the membership changed under it (member removed,
--                                 signer replaced, roster materially changed). This
--                                 is the BACKBONE of "die on change": rotating the
--                                 access code alone does not revoke a member who can
--                                 log into the portal, because the portal rebuilds a
--                                 working link from their contact record on demand.
--                                 Every signing door refuses a revoked row. A signed
--                                 row is NEVER revoked.
--
--   revoked_reason   text         Plain-English audit of why (e.g. "member removed",
--                                 "roster changed", "superseded by re-send").
--
-- All three are nullable and additive. No backfill: production has 9 signature
-- rows, all already signed, so none is touched. SMLLC agreements carry no
-- signature rows at all and are structurally unaffected.

ALTER TABLE public.oa_signatures
  ADD COLUMN IF NOT EXISTS link_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at      timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_reason  text;

COMMENT ON COLUMN public.oa_signatures.link_expires_at IS
  'When the emailed per-signer signing link stops working. NULL = never emailed = never expires. Stamped now()+15d at email time. Only the per-signer MMLLC link expires; the shared-code/SMLLC/portal path is untouched. A signed row is never blocked by expiry.';
COMMENT ON COLUMN public.oa_signatures.revoked_at IS
  'When this signer credential was killed by a membership change (die-on-change). Every signing door refuses a revoked row. A signed row is NEVER revoked. Rotating the access code alone is insufficient because the portal re-derives a working link from contact_id.';
COMMENT ON COLUMN public.oa_signatures.revoked_reason IS
  'Plain-English audit reason for revoked_at (e.g. member removed, roster changed, superseded by re-send).';

-- ── Close the last anon-write hole on the OA tables ─────────────────────────
-- The legacy bare-token OA page is now a pure redirect (its browser-side anon
-- write is gone) and the canonical page signs server-side, so the browser NEVER
-- writes oa_agreements / oa_signatures with the anon key. The anon UPDATE grant
-- was already revoked in production; drop the now-inert USING(true) UPDATE
-- policies too, so a future re-grant cannot silently re-open the write. All
-- IF EXISTS / idempotent — a no-op on sandbox (which never had them) and safe to
-- re-run on production. The anon SELECT(id) grant + the "signing writes" SELECT
-- policies from 20260722-0100 are LEFT ALONE (the browser still needs id-level
-- visibility), and the signed-oa storage bucket is untouched.
REVOKE UPDATE ON public.oa_agreements FROM anon;
REVOKE UPDATE ON public.oa_signatures FROM anon;
DROP POLICY IF EXISTS "Public update by id" ON public.oa_agreements;
DROP POLICY IF EXISTS "Allow anon update" ON public.oa_signatures;
