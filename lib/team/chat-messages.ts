/**
 * Floating chat window — message list handling.
 *
 * Pure, because both rules here are silent-corruption bugs if they drift:
 * duplicated sends, and retracted text staying on screen.
 */

export interface ChatMessage {
  id: string
  sender_id?: string | null
  sender_name?: string | null
  message?: string | null
  created_at?: string | null
  deleted_at?: string | null
  attachments?: unknown
}

/**
 * Fold incoming messages into the list, newest last, one row per id.
 *
 * WHY DEDUPE IS MANDATORY: a send both appends the POST response optimistically
 * AND comes back through the realtime feed. Without an id-keyed merge every
 * message you send appears twice. The LATER copy wins on conflict, so an UPDATE
 * (an edit, or a soft delete) overwrites the row it amends rather than adding to
 * it — which is also what makes deletions land live.
 */
export function mergeChatMessages(
  existing: readonly ChatMessage[] | null | undefined,
  incoming: readonly ChatMessage[] | null | undefined,
): ChatMessage[] {
  const byId = new Map<string, ChatMessage>()
  for (const m of existing ?? []) if (m?.id) byId.set(m.id, m)
  for (const m of incoming ?? []) if (m?.id) byId.set(m.id, { ...byId.get(m.id), ...m })
  return Array.from(byId.values()).sort((a, b) => {
    const at = a.created_at ?? ''
    const bt = b.created_at ?? ''
    if (at === bt) return (a.id ?? '').localeCompare(b.id ?? '')
    return at.localeCompare(bt)
  })
}

/** Text shown in place of a soft-deleted message. Must match the full chat page. */
export const DELETED_MESSAGE_TEXT = 'Message deleted'

/**
 * What to actually render for a message.
 *
 * THE TRAP: the thread endpoint deliberately RETURNS soft-deleted rows, body and
 * all, so the UI can draw a tombstone in the right place. The full chat page
 * re-checks that client-side; a new surface that just prints `message` shows
 * text its author has retracted — the money figure they corrected, the name they
 * took back. Every renderer must go through here.
 */
export function displayBody(m: ChatMessage | null | undefined): string {
  if (!m) return ''
  if (m.deleted_at) return DELETED_MESSAGE_TEXT
  const body = (m.message ?? '').trim()
  if (body) return body
  return attachmentCount(m) > 0 ? 'Attachment' : ''
}

/** True when the message has been retracted. */
export function isDeleted(m: ChatMessage | null | undefined): boolean {
  return !!m?.deleted_at
}

/**
 * Group a message's reactions into one chip per emoji, with who reacted.
 *
 * Tolerant of shape: reactions are stored as a JSON array written by a database
 * function, so a malformed or half-written row must render as "no reactions"
 * rather than throwing inside the message list — a crash there takes the whole
 * floating window down.
 */
export function summarizeReactions(
  m: ChatMessage | null | undefined,
): Array<{ emoji: string; count: number; names: string[] }> {
  const raw = (m as { reactions?: unknown } | null | undefined)?.reactions
  if (!Array.isArray(raw)) return []
  const byEmoji = new Map<string, { emoji: string; count: number; names: string[] }>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const emoji = (entry as { emoji?: unknown }).emoji
    if (typeof emoji !== 'string' || !emoji) continue
    const name = (entry as { reactor_name?: unknown }).reactor_name
    const row = byEmoji.get(emoji) ?? { emoji, count: 0, names: [] }
    row.count += 1
    if (typeof name === 'string' && name) row.names.push(name)
    byEmoji.set(emoji, row)
  }
  return Array.from(byEmoji.values())
}

/** How many files ride along. Never returns their URLs — the window shows count and name only. */
export function attachmentCount(m: ChatMessage | null | undefined): number {
  const a = m?.attachments
  return Array.isArray(a) ? a.length : 0
}

/**
 * Build the body of a note made from ONE message.
 *
 * Carries who said it, so a quote pulled out of context is still attributable
 * weeks later. Truncates to the note's real limit rather than the 200 characters
 * the shared dialog silently used.
 */
export function buildNoteFromMessage(m: ChatMessage, maxLen: number): string {
  const who = (m.sender_name ?? '').trim() || 'Someone'
  return truncate(`${who}: ${displayBody(m)}`, maxLen)
}

/**
 * Build the body of a note made from a WHOLE conversation.
 *
 * Deterministic truncation: keep the MOST RECENT messages, because the end of a
 * conversation is where the decision lives, and mark clearly that earlier turns
 * were dropped. Silently keeping the first 200 characters — which is what the
 * shared dialog did — would preserve the greeting and lose the conclusion.
 */
export function buildNoteFromConversation(
  messages: readonly ChatMessage[] | null | undefined,
  maxLen: number,
): string {
  const lines: string[] = []
  let used = 0
  let dropped = 0
  const rows = (messages ?? []).filter(Boolean)
  for (let i = rows.length - 1; i >= 0; i--) {
    const line = `${(rows[i].sender_name ?? '').trim() || 'Someone'}: ${displayBody(rows[i])}`
    if (used + line.length + 1 > maxLen - 40) { dropped = i + 1; break }
    lines.unshift(line)
    used += line.length + 1
  }
  if (dropped > 0) lines.unshift(`(${dropped} earlier message${dropped === 1 ? '' : 's'} not included)`)
  return truncate(lines.join('\n'), maxLen)
}

function truncate(s: string, maxLen: number): string {
  if (maxLen <= 0) return ''
  if (s.length <= maxLen) return s
  return `${s.slice(0, Math.max(0, maxLen - 1))}…`
}
