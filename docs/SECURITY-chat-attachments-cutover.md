# Chat attachments — private-bucket cutover (security audit 2026-06-13, H6)

## The problem
Portal chat attachments are uploaded to the **public** `assets` bucket
(`assets.public = true`) under `chat-attachments/<accountId|contactId>/<uuid>.<ext>`
and the uploader returns a **direct, non-expiring public URL**
(`app/api/portal/chat/upload-url/route.ts` → `getPublicUrl`). Filenames are
`randomUUID()` so paths aren't enumerable, but any URL that leaks (forwarded
email, server log, browser referrer) gives **permanent, unauthenticated** access
to PII — chat attachments include passport photos and IDs.

## What shipped in this change (the code half)
A new **access-controlled proxy** route:

- `GET /api/portal/chat/attachment?path=chat-attachments/<dir>/<file>`
  (`app/api/portal/chat/attachment/route.ts`)
- Verifies the caller may access the thread (`canAccessAccount(... 'chat')` for
  account threads, `contactId` match for contact-only threads, staff pass), then
  streams the bytes from storage via the **service key**.
- Works whether the bucket is public or private, so it is safe to deploy now and
  is the prerequisite for locking the bucket.

## What still must be done on PRODUCTION (the infra half — NOT done here)
These steps touch the live Supabase storage config + stored data and require
production access + a migration. They were **not** performed in this code-only
sandbox session.

1. **Point new uploads at the proxy.** In `chat/upload-url/route.ts`, return the
   proxy URL (`/api/portal/chat/attachment?path=<storagePath>`) instead of
   `getPublicUrl(...)`.
2. **Update chat-send URL validation.** `app/api/portal/chat/route.ts` currently
   rejects any attachment URL that does not `startsWith(NEXT_PUBLIC_SUPABASE_URL)`.
   Add the proxy path prefix (`/api/portal/chat/attachment?`) as an accepted form.
3. **Update render sites** to use the proxy URL (they already render `att.url`
   directly, so once the stored URL is the proxy URL this is automatic):
   `components/portal/portal-chat.tsx`, `app/(dashboard)/portal-chats/page.tsx`,
   `components/contacts/contact-detail.tsx`.
4. **Backfill existing rows.** Migrate `portal_messages.attachments[].url` and
   `portal_messages.attachment_url` from public URLs → proxy URLs (a
   `scripts/migrations/*.sql` UPDATE rewriting the host/prefix).
5. **Flip the bucket private.** Set `assets.public = false` (or move
   `chat-attachments/*` to a dedicated private bucket) AFTER steps 1–4, so no
   live link breaks.

Until step 5, attachments remain publicly reachable by direct URL. The proxy is
in place so the cutover is a configuration + data migration, not new code.
