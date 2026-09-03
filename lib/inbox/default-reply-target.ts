/**
 * Client-safe pure logic for "which message would an untargeted action
 * (Reply, Forward) act on by default" — pick the newest message that ISN'T
 * one of our own, falling back to the literal newest only when every message
 * in the thread is outbound (nothing else to target, not a misdirect).
 *
 * This mirrors the server-side default in lib/inbox/reply-target.ts, but
 * runs entirely on already-fetched `direction` fields (no Gmail call) — used
 * by message-thread.tsx (the Reply/Reply-All default-target indicator) and
 * inbox-shell.tsx (Forward, dev job ec61a2ae: Forward previously always
 * grabbed the literal newest message, the same bug class Reply had).
 */
export function pickNewestNonOwnMessage<T extends { direction: string }>(
  messages: T[]
): T | null {
  if (messages.length === 0) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].direction !== "outbound") return messages[i]
  }
  return messages[messages.length - 1]
}
