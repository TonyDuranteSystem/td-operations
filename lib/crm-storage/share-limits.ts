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
// its own), so this is a conservative, document-sized ceiling to fail fast
// on an obviously-wrong pick (a video, a multi-GB recording) rather than
// spend a minute base64-encoding it in the browser first.
export const FAX_SHARE_MAX_BYTES = 20 * 1024 * 1024
export const FAX_SHARE_MAX_MB = 20

export function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}
