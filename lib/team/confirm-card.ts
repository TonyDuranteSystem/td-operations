/**
 * The Team Chat Confirm-card decision, kept OUT of `claude-trigger.ts` on purpose.
 *
 * That module imports `server-only`, which makes every function in it
 * unreachable from a unit test. This guard is one line, it fails silently when
 * it regresses (a permanent channel message reading "Confirm email to null"),
 * and `strict: false` in tsconfig means the types alone would not catch it — so
 * it has to be testable. Pure, no imports, no side effects.
 */

/** The shape Team Chat renders for a Confirm card, or null for "attach nothing". */
export type TeamChatConfirmCard = {
  kind: 'email_confirm'
  title: string
  subtitle?: string
  entity_type: 'worker_prepared_send'
  entity_id: string
  body: string
  /**
   * The files that will go out, rendered as the files themselves (image inline,
   * anything else as a tile that opens) — NOT as a link and NOT as a name in a
   * subtitle. Deliberately carries no URL: this card is a permanent channel
   * message, so a baked signed URL would be either a dead tile forever or a
   * long-lived bearer link to a client document sitting in the scrollback. The
   * renderer builds a staff-authenticated path from `entity_id` + the position
   * in this list, and that path re-checks who is asking on every open.
   */
  files?: Array<{ name: string; size?: number; content_type?: string; origin?: string; warning?: string }>
}

/**
 * WHICH FROZEN DRAFT GETS A TEAM CHAT CARD — and what that card says.
 *
 * EMAIL ONLY, deliberately. A frozen PORTAL draft carries no to_address and no
 * subject (the database physically refuses to store them on a portal row), so
 * without this guard the caller would write a permanent, channel-visible chat
 * message reading "Confirm email to null" — and unlike the ephemeral panel
 * cards, that one stays in the channel for anyone to click. Team Chat has no
 * client picker and no language dropdown, so it cannot host a portal card at
 * all: the right answer is to suppress it, not to adapt it.
 *
 * Explicit `kind === 'email'` on purpose: tsconfig runs with `strict: false`,
 * so the nullable types alone would not have caught this at build time.
 *
 * Pure so it can be tested without a database — the guard is otherwise buried
 * in a long side-effecting function and was shipping untested.
 */
export function teamChatCardForFrozenDraft(
  prep: {
    id: string
    kind?: string | null
    to_address?: string | null
    subject?: string | null
    body?: unknown
    attachments?: Array<{ name?: string; size?: number; content_type?: string; origin?: string; warning?: string }> | null
  } | null,
): TeamChatConfirmCard | null {
  if (!prep || prep.kind !== 'email') return null
  // Anything without a name cannot be rendered as a file and must not silently
  // disappear from the card while still being attached to the email — so the
  // filter is on the FILE, and a nameless one still occupies its position.
  const files = (prep.attachments ?? []).map((a) => ({
    name: a?.name || 'file',
    size: a?.size,
    content_type: a?.content_type,
    origin: a?.origin,
    warning: a?.warning,
  }))
  return {
    kind: 'email_confirm',
    title: `Confirm email to ${prep.to_address}`,
    // The subject only. The files are rendered as files below — listing their
    // names here too would put a filename in front of the human as if that were
    // something they could check.
    subtitle: prep.subject || undefined,
    entity_type: 'worker_prepared_send',
    entity_id: prep.id,
    ...(files.length ? { files } : {}),
    // The exact body that will be sent, so Confirm approves a MESSAGE and not
    // just an address (the panels render it for the same reason).
    body: typeof prep.body === 'string' ? prep.body : '',
  }
}

