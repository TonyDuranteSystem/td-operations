/**
 * Team Workspace — Share-to-Team pure helpers.
 *
 * Card normalization + validation for POST /api/team/share, extracted so the
 * route stays a thin IO shell and this logic is unit-testable without a DB.
 * The route resolves the recipient (support person / teammate) and does the
 * DB writes; everything here is pure.
 */
import { validateTeamCard, type TeamCard } from '@/lib/team/workspace'

export const MAX_SHARE_ITEMS = 25

/** Max characters of shared source text embedded in the chat message body.
 *  Keeps a giant quoted email thread from flooding the chat; the card links to
 *  the original for the full thing. Normal transactional emails fit well under. */
export const SHARE_BODY_CAP = 4000

export interface ShareItemInput {
  kind?: string
  title?: string
  subtitle?: string
  url?: string
  color?: string
  entity_type?: string
  entity_id?: string
  /** Full source text (whole email / portal message) to embed in the message body. */
  body?: string
}

/**
 * Compose the chat message body for one shared item: the sharer's note followed
 * by the item's full source text. The source text is capped (with a truncation
 * marker) so an enormous email thread doesn't flood the chat — the card still
 * links to the original. Both parts are optional; returns '' if both are empty
 * (the card alone still renders).
 */
export function composeShareMessage(
  note: string | undefined | null,
  body: string | undefined | null,
  cap: number = SHARE_BODY_CAP,
): string {
  const n = (note ?? '').trim()
  let b = (body ?? '').trim()
  if (b.length > cap) {
    b = b.slice(0, cap).trimEnd() + '\n\n…(truncated — open the original from the card above)'
  }
  return [n, b].filter(Boolean).join('\n\n')
}

export interface BuildShareCardsResult {
  /** The normalized cards. Empty when `error` is set. */
  cards: TeamCard[]
  /** A user-facing validation error, or null when the batch is valid. */
  error: string | null
}

/**
 * Validate + normalize the raw share items into TeamCards.
 * - rejects empty / non-array / over-limit
 * - defaults kind to 'client_message'
 * - requires an in-app RELATIVE url when a url is present (no external links)
 * - runs each card through validateTeamCard
 * Returns the first error encountered (fail-closed): on error, `error` is set
 * and `cards` is empty; on success, `error` is null.
 */
export function buildShareCards(
  rawItems: unknown,
  maxItems: number = MAX_SHARE_ITEMS,
): BuildShareCardsResult {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { cards: [], error: 'Nothing to share.' }
  }
  if (rawItems.length > maxItems) {
    return { cards: [], error: `Too many items — share at most ${maxItems} at a time.` }
  }

  const cards: TeamCard[] = []
  for (const raw of rawItems as ShareItemInput[]) {
    const it = raw || {}
    const card: TeamCard = {
      kind: (it.kind as TeamCard['kind']) || 'client_message',
      title: (it.title ?? '').toString(),
      ...(it.subtitle ? { subtitle: String(it.subtitle) } : {}),
      ...(it.url ? { url: String(it.url) } : {}),
      ...(it.color ? { color: String(it.color) } : {}),
      ...(it.entity_type ? { entity_type: String(it.entity_type) } : {}),
      ...(it.entity_id ? { entity_id: String(it.entity_id) } : {}),
    }
    if (card.url && !card.url.startsWith('/')) {
      return { cards: [], error: 'Card link must be a relative in-app URL.' }
    }
    const err = validateTeamCard(card)
    if (err) return { cards: [], error: err }
    cards.push(card)
  }

  return { cards, error: null }
}
