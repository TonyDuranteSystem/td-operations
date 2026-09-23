/**
 * CRM Storage deliberately has NO upload size cap (Antonio, 2026-09 — full
 * Zoom recordings, etc.), but every SHARE destination below does have one,
 * because each copies the file into its own separate store. Checking here,
 * before attempting a share, turns "silently hangs then fails" on a huge
 * file into an immediate, clear message.
 */

// Mirrors the `assets` bucket's file_size_limit (scripts/migrations/20260530-1200-chat-assets-bucket-size-limit.sql),
// which both Team Chat and Portal Chat attachments copy into.
export const CHAT_SHARE_MAX_BYTES = 100 * 1024 * 1024
export const CHAT_SHARE_MAX_MB = 100

// Mirrors MAX_EMAIL_ATTACHMENT_TOTAL_BYTES (lib/inbox/email-attachment-staging.ts) — Gmail's own combined-attachment cap.
export const EMAIL_SHARE_MAX_BYTES = 18 * 1024 * 1024
export const EMAIL_SHARE_MAX_MB = 18

// Fax transmits a handful of scanned pages, not arbitrary media — no existing
// constant to mirror (app/api/tools/fax/send/route.ts has no size guard of
// its own; the existing fax tool page sends the exact same file_base64-in-a-
// JSON-body shape this dialog does, confirmed 2026-09-23 in fax-form.tsx).
// The real ceiling here isn't fax itself, it's the transport: base64
// inflates a file by ~1.37x, and this hand-rolled route (unlike this
// project's resumable-upload path, which exists specifically to bypass this
// same limit) has no protection from the platform's own request-body cap.
// A prior "20 MB" ceiling promised a size that could never actually reach
// the fax route intact — this value keeps the base64 payload safely under
// that cap instead of failing with a raw platform error on an ordinary
// multi-page scan (bug-hunter, 2026-09-23).
export const FAX_SHARE_MAX_BYTES = 3 * 1024 * 1024
export const FAX_SHARE_MAX_MB = 3

export function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}
