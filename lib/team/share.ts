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

export interface ShareItemInput {
  kind?: string
  title?: string
  subtitle?: string
  url?: string
  color?: string
  entity_type?: string
  entity_id?: string
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
