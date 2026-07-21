-- 2026-07-21 URGENT REVERT — restore two grants that the earlier revoke took away.
--
-- WHAT I GOT WRONG
-- Migration 20260721-0900 revoked UPDATE on ss4_applications and
-- form_8832_applications from anon, on the basis that "the signing pages only
-- read". That was WRONG. Both pages DO write, from the browser:
--   app/ss4/[token]/[code]/page.tsx:96   — view tracking on load
--   app/ss4/[token]/[code]/page.tsx:222  — marks status='signed', signed_at,
--                                          signature_data  ← the actual signature
--   app/8832/[token]/[code]/page.tsx:84  — view tracking on load
--   app/8832/[token]/[code]/page.tsx:199 — marks the form signed
--
-- WHY THE CHECK MISSED IT: both files assign the client to a local first
-- (`const supabase = supabasePublic`, ss4 :65/:161, 8832 :56/:141) and then call
-- `supabase.from(...)`. The audit matched the literal chain `supabasePublic
-- .from(...)`, so an aliased client was invisible to it. A text search stood in
-- for tracing the flow. Any future grant audit MUST resolve aliases, or better,
-- exercise the flow.
--
-- IMPACT WHILE IT WAS REVOKED: the signature write is not error-checked, and the
-- page calls setSigned(true) regardless (ss4 :218-240). So the client saw a
-- green "Signed" screen, the signed PDF WAS stored (that path goes through the
-- server route with the service key), but the database never recorded the
-- signature and the downstream notification/fax task never fired. Silent.
--
-- member_info_requests is NOT restored here: components/forms/member-info-form.tsx
-- only reads (:111); its writes go through
-- app/api/member-info/[token]/[access_code]/route.ts (service key). Verified.
-- action_log / email_tracking are NOT restored: every writer is supabaseAdmin,
-- and their policies have since been correctly rescoped to authenticated.
--
-- DETECTION of affected clients: the signed PDF exists in storage while the row
-- still says awaiting_signature — that mismatch is the signal.

BEGIN;

GRANT UPDATE ON public.ss4_applications       TO anon;
GRANT UPDATE ON public.form_8832_applications TO anon;

COMMIT;
