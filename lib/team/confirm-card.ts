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
  prep: { id: string; kind?: string | null; to_address?: string | null; subject?: string | null; body?: unknown; attachments?: Array<{ name?: string }> | null } | null,
): TeamChatConfirmCard | null {
  if (!prep || prep.kind !== 'email') return null
  const files = (prep.attachments ?? [])
    .map((a) => a?.name)
    .filter(Boolean)
    .join(', ')
  return {
    kind: 'email_confirm',
    title: `Confirm email to ${prep.to_address}`,
    subtitle: [prep.subject, files ? `📎 ${files}` : ''].filter(Boolean).join(' — ') || undefined,
    entity_type: 'worker_prepared_send',
    entity_id: prep.id,
    // The exact body that will be sent, so Confirm approves a MESSAGE and not
    // just an address (the panels render it for the same reason).
    body: typeof prep.body === 'string' ? prep.body : '',
  }
}

