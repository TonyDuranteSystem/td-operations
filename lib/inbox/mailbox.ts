/**
 * The one place the inbox's short mailbox key ('support' | 'antonio', as sent
 * by the browser and stored in email_snoozes.mailbox) maps to the Gmail
 * account to impersonate. The email-actions route and the unsnooze cron BOTH
 * use this — a drifted copy in the cron would modify the wrong mailbox and
 * poison snooze rows with 404s (council bug-hunter, 2026-07-28).
 */
export function resolveMailbox(mailbox?: string | null): string {
  return mailbox === "antonio"
    ? "antonio.durante@tonydurante.us"
    : "support@tonydurante.us"
}
