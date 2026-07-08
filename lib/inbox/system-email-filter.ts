/**
 * System-notification email filter for the CLIENT email views (Portal Chats
 * Email tab + account page Emails tab). Antonio 2026-07-08: these
 * machine-generated notices drowned the real correspondence — "too noisy".
 *
 * Filters ONLY our own automated notification emails to clients, verified
 * against the actual senders' subject builders:
 *  - portal digest (app/api/cron/portal-digest): "N new update(s) in your
 *    portal" / "N nuovo aggiornamento | nuovi aggiornamenti nel tuo portale"
 *  - chat notify (lib/portal/notifications.ts): "New message from the Tony
 *    Durante team" / "Nuovo messaggio dal team Tony Durante"
 *
 * NOT filtered: invoices, reminders, documents, human mail — anything a
 * staff member might genuinely need to see in the client's history. The
 * full record always remains in Gmail and the main Inbox.
 */

const SYSTEM_SUBJECT_PATTERNS: RegExp[] = [
  /\bnew updates? in your portal\b/i,
  /\bnuov[oi] aggiornament[oi] nel tuo portale\b/i,
  /^(re:\s*)?new message from the tony durante team\b/i,
  /^(re:\s*)?nuovo messaggio dal team tony durante\b/i,
]

/** True when the subject belongs to one of our automated notification emails. */
export function isSystemNotificationSubject(subject: string | null | undefined): boolean {
  if (!subject) return false
  return SYSTEM_SUBJECT_PATTERNS.some((re) => re.test(subject))
}
