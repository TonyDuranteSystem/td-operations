/**
 * Mailbox guard for the AI workers' gmail read tools.
 *
 * The workers (Slack, Telegram/Hermes, in-dashboard agent) read email from a
 * single default mailbox (support@tonydurante.us) unless an `as_user` mailbox is
 * passed. Because the workers ingest channel/thread content that could carry
 * injected instructions, `as_user` is restricted to an allow-list — Antonio can
 * have a worker read HIS inbox on request, but a prompt-injected message cannot
 * make it open a third party's mailbox.
 *
 * Allow-list is env-configurable (GMAIL_WORKER_ALLOWED_MAILBOXES, comma-separated)
 * and defaults to support@ + Antonio's personal address.
 */

export const DEFAULT_MAILBOX = "support@tonydurante.us"

/** The set of mailboxes a worker may target via `as_user`, lower-cased. */
export function allowedMailboxes(): string[] {
  const env = process.env.GMAIL_WORKER_ALLOWED_MAILBOXES
  const list = (env ? env.split(",") : [DEFAULT_MAILBOX, "antonio.durante@tonydurante.us"])
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return list.length ? list : [DEFAULT_MAILBOX]
}

/**
 * Resolve a requested mailbox to the value passed to gmailGet's `asUser`:
 *   - undefined/empty  -> null (use the default mailbox)
 *   - allow-listed     -> the normalized mailbox
 *   - not allow-listed -> throws (the tool surfaces the error to the model)
 */
export function resolveMailbox(asUser?: string, allowed: string[] = allowedMailboxes()): string | null {
  if (asUser == null || typeof asUser !== "string" || !asUser.trim()) return null
  const m = asUser.trim().toLowerCase()
  if (!allowed.includes(m)) {
    throw new Error(
      `Mailbox '${asUser}' is not permitted for the assistant. Allowed: ${allowed.join(", ")}.`,
    )
  }
  return m
}
