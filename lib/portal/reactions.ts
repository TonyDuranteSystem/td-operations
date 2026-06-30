/**
 * Emoji reactions on chat messages (CRM + client portal).
 *
 * Reactions live on the message row as a JSONB array (`portal_messages.reactions`).
 * This module is the single source of truth for the element shape and the pure
 * grouping logic the UI renders. No DB / React imports here so it stays unit-testable.
 */

export interface MessageReaction {
  emoji: string
  /** contact_id (client), auth uid (teammate/staff). Identifies one reactor. */
  reactor_id: string
  reactor_type: 'client' | 'staff'
  /** Display name for the "who reacted" tooltip. Null for staff (rendered generically). */
  reactor_name: string | null
  created_at: string
}

/** One emoji grouped across all reactors, ready to render as a pill. */
export interface ReactionGroup {
  emoji: string
  count: number
  /** Display names of reactors (nulls dropped); staff fall back to `staffLabel`. */
  names: string[]
  /** True when the viewer is among the reactors for this emoji. */
  mine: boolean
}

/** Max length of a reaction emoji string. Generous to allow ZWJ sequences
 *  (e.g. 👨‍👩‍👧‍👦, 🧑🏽‍💻) which are multiple code points but one glyph. */
export const REACTION_EMOJI_MAX_LEN = 32

/** localStorage key for the per-device "last picked" reaction (one-tap reuse). */
export const LAST_REACTION_STORAGE_KEY = 'td-chat-last-reaction'

/**
 * Validate a candidate reaction emoji. We deliberately do NOT hard-restrict to a
 * fixed allow-list (Antonio chose "full picker"), but we reject empty, overly
 * long, whitespace, or anything containing ASCII letters/digits — a cheap guard
 * against a non-emoji string being POSTed as a "reaction".
 */
export function isValidReactionEmoji(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (v.length === 0 || v.length > REACTION_EMOJI_MAX_LEN) return false
  if (v !== value) return false // no surrounding whitespace
  if (/[A-Za-z0-9]/.test(v)) return false // emoji glyphs carry no ASCII alnum
  return true
}

/**
 * Group a raw reactions array into render-ready pills.
 * - Preserves first-seen emoji order (stable across re-renders).
 * - `mine` is true when `viewerReactorId` matches any reactor of that emoji.
 * - Defensive against malformed rows (missing fields / non-array input).
 */
export function summarizeReactions(
  reactions: MessageReaction[] | null | undefined,
  viewerReactorId: string | null | undefined,
  staffLabel = 'Team',
): ReactionGroup[] {
  if (!Array.isArray(reactions) || reactions.length === 0) return []

  const order: string[] = []
  const byEmoji = new Map<string, ReactionGroup>()

  for (const r of reactions) {
    if (!r || typeof r.emoji !== 'string' || r.emoji.length === 0) continue
    let group = byEmoji.get(r.emoji)
    if (!group) {
      group = { emoji: r.emoji, count: 0, names: [], mine: false }
      byEmoji.set(r.emoji, group)
      order.push(r.emoji)
    }
    group.count += 1
    const name = r.reactor_name && r.reactor_name.trim()
      ? r.reactor_name.trim()
      : (r.reactor_type === 'staff' ? staffLabel : null)
    if (name) group.names.push(name)
    if (viewerReactorId && r.reactor_id === viewerReactorId) group.mine = true
  }

  return order.map(e => byEmoji.get(e)!)
}
