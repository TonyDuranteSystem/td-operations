-- ============================================================================
-- Storage security remediation — security audit 2026-06-13, CRITICAL-3 (C3)
-- ============================================================================
--
-- ⚠️ DO NOT APPLY BLINDLY. Storage policies gate client PII (passports, IDs,
--    bank statements, tax docs). Read the PRECONDITIONS below first, make the
--    companion code change for the anonymous external onboarding form, then
--    test in sandbox across EVERY upload/read path before promoting to prod.
--
-- WHAT IS WRONG (verified live in sandbox storage.objects; the bucket-creation
-- migration 20260609-1210 asserts production carries the identical policies):
--
--   Bucket `onboarding-uploads` (public=false at the bucket level) has TWO
--   storage.objects policies granted to role PUBLIC (which includes `anon`):
--     • "Allow public read onboarding"   SELECT USING (bucket_id = 'onboarding-uploads')
--     • "Allow public upload onboarding" INSERT WITH CHECK (bucket_id = 'onboarding-uploads')
--   No per-account / per-token / per-owner scoping. Net effect:
--     - ANYONE with the anon key (shipped to every browser) can DOWNLOAD any
--       client's file if they know/guess the path, and OVERWRITE/UPLOAD to any
--       path. Paths are guessable (wizard: {wizardType}/{email}/...; external
--       form: {token}/{key}_{filename}).
--
-- ─── HOW THE BUCKET IS USED TODAY (verified in code) ────────────────────────
--
--   WRITE path 1 — Portal wizard (LOGGED-IN client):
--     app/api/portal/wizard-upload-url/route.ts mints the path; the browser
--     uploads directly to storage authenticated with the client's OWN session
--     token (resumable TUS). Path: {wizardType}/{identifier}/{field}_{uuid}_{file}
--     where identifier defaults to the client's email.
--     → This path works with an AUTHENTICATED, owner-scoped INSERT policy.
--
--   WRITE path 2 — External onboarding form (ANONYMOUS, no login):
--     app/onboarding-form/[token]/page.tsx:236 uploads via the ANON client
--     (`supabasePublic`). Path: {token}/{key}_{filename}. There is NO session,
--     so this write CANNOT be owner-scoped by auth.uid()/email.
--     → ⚠️ Removing the anon INSERT policy (as this migration does) BREAKS this
--       form until it is changed to upload through a SERVER route using the
--       service-role key. SEE PRECONDITION 1.
--
--   READ path — Staff / server:
--     Files are read server-side via the service-role client (supabaseAdmin),
--     which BYPASSES RLS. So removing the public SELECT policy does NOT break
--     legitimate reads. (No client-side anon read of this bucket exists.)
--
-- ─── PRECONDITIONS (must be true BEFORE applying) ───────────────────────────
--
--   PRECONDITION 1 — Migrate the external onboarding form off the anon client.
--     Change app/onboarding-form/[token]/page.tsx to POST the file to a new
--     server route that validates the submission token and uploads with the
--     service-role key (the path already carries the token). After that ships,
--     no anonymous write to this bucket remains and Step 3 below is safe.
--     Until then, applying this migration will 403 the external form's uploads.
--
--   PRECONDITION 2 — Confirm no other code reads this bucket with the anon
--     client. (grep: `from('onboarding-uploads')` on supabasePublic/anon.)
--
-- ============================================================================
-- onboarding-uploads — lock down (C3)
-- ============================================================================

-- 1. Ensure the bucket itself is private (defense in depth; already false in
--    sandbox + prod per the creation migration, but assert it explicitly).
update storage.buckets set public = false where id = 'onboarding-uploads';

-- 2. Remove the world-readable + world-writable PUBLIC policies.
drop policy if exists "Allow public read onboarding"   on storage.objects;
drop policy if exists "Allow public upload onboarding" on storage.objects;

-- 3. Authenticated, owner-scoped INSERT (portal wizard — WRITE path 1).
--    A logged-in client may only write under a path prefix that belongs to
--    them: the 2nd path segment must equal their email or their uid. This
--    matches wizard-upload-url's `{wizardType}/{identifier}/...` scheme.
--    NOTE: identifier is currently request-body controlled (audit L4); the
--    companion hardening is to derive it strictly from the session server-side
--    so a client cannot spoof another client's prefix. This policy enforces the
--    constraint at the DB regardless.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'onboarding-uploads authenticated owner insert'
  ) then
    create policy "onboarding-uploads authenticated owner insert"
      on storage.objects for insert
      to authenticated
      with check (
        bucket_id = 'onboarding-uploads'
        and (storage.foldername(name))[2] in (
          auth.jwt() ->> 'email',
          auth.uid()::text
        )
      );
  end if;
end $$;

-- 4. Authenticated, owner-scoped SELECT (defense in depth — server reads use
--    the service key and bypass RLS, but if any future client-side read is
--    added it must be scoped, never public).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'onboarding-uploads authenticated owner read'
  ) then
    create policy "onboarding-uploads authenticated owner read"
      on storage.objects for select
      to authenticated
      using (
        bucket_id = 'onboarding-uploads'
        and (storage.foldername(name))[2] in (
          auth.jwt() ->> 'email',
          auth.uid()::text
        )
      );
  end if;
end $$;

-- No anon policy is recreated. After PRECONDITION 1 ships, the external
-- onboarding form uploads server-side with the service key (RLS-exempt), so no
-- anonymous access to this bucket remains.

-- ============================================================================
-- OTHER PUBLIC BUCKETS WITH SENSITIVE DATA — NOT FIXED BY THIS SQL FILE
-- ============================================================================
--
-- The audit flags additional buckets, but each requires a COMPANION CODE CHANGE
-- and CANNOT be safely remediated with storage policies alone. Flipping them
-- here would instantly break live client-facing flows. They are documented (not
-- executed) so the remediation is tracked, not silently dropped:
--
--   • `assets` (public=true) — audit H6. Holds portal CHAT ATTACHMENTS incl.
--     passport photos. The code returns PUBLIC, non-expiring URLs to clients
--     (app/api/portal/chat/upload-url/route.ts). Setting public=false WITHOUT
--     first switching chat to signed-URL-on-read would break every existing
--     attachment link in client chats. Fix: move chat attachments to a private
--     bucket served via short-lived signed URLs, THEN flip public=false.
--
--   • `signed-contracts` / `signed-leases` / `signed-oa` — audit H7. Read with
--     the ANON client keyed only by the offer/lease/OA token on the public
--     contract pages (app/offer/[token]/contract, app/lease/[token]/[code],
--     app/operating-agreement/[token]/[code]). Adding owner RLS / removing
--     public read would break client legal-document viewing. Fix: bind
--     token→record→file server-side and serve via the service key + signed URL,
--     THEN lock the buckets.
--
-- Each of the above is its own dev_task with a code change + its own migration.
-- ============================================================================

-- ─── ROLLBACK (if a sandbox test reveals a broken path) ─────────────────────
-- To restore the previous (insecure) behavior during testing only:
--   drop policy if exists "onboarding-uploads authenticated owner insert" on storage.objects;
--   drop policy if exists "onboarding-uploads authenticated owner read"   on storage.objects;
--   create policy "Allow public read onboarding"   on storage.objects for select using (bucket_id = 'onboarding-uploads');
--   create policy "Allow public upload onboarding" on storage.objects for insert with check (bucket_id = 'onboarding-uploads');
