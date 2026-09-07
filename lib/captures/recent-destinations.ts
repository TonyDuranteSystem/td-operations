/**
 * "Remembers your last couple of destinations, so sending to the same place
 * again is one tap" (Antonio, 2026-09-04). Purely a per-viewer convenience —
 * localStorage, not server state, same choice HelpProvider already made for
 * an equivalent "remember my preference" need in this codebase.
 *
 * portal_chat (Phase 2, 2026-09-04) keeps its own explicit contactId/
 * accountId rather than being squeezed into the two-destination `id: string`
 * shape below it — an opaque id can't tell "which of this LLC's members was
 * this actually addressed to," and re-deriving that on reuse via a fallback
 * heuristic can silently re-tag the wrong member (an ai-architect +
 * bug-hunter finding on the Phase 2 council pass). REQUIRES_CONFIRMATION is a
 * data-driven map, not a branch buried in the caller, precisely because the
 * caller's own natural implementation of "add a type" is a same-shaped extra
 * arm — the exact thing that would have silently skipped confirmation for
 * this one destination that must never skip it (bug-hunter blocker, same
 * pass): every caller must consult this map, never hardcode which types are
 * instant-send.
 */

export type RecentDestination =
  | { type: 'sticky_note'; id: string; label: string }
  | { type: 'team_chat'; id: string; label: string }
  | { type: 'portal_chat'; contactId: string; accountId: string | null; label: string }

export const REQUIRES_CONFIRMATION: Record<RecentDestination['type'], boolean> = {
  sticky_note: false,
  team_chat: false,
  portal_chat: true,
}

const STORAGE_KEY = 'td-capture-recent-destinations'
const MAX_RECENTS = 3

function isRecentDestination(d: unknown): d is RecentDestination {
  if (!d || typeof d !== 'object') return false
  const r = d as Record<string, unknown>
  if (typeof r.label !== 'string') return false
  if (r.type === 'sticky_note' || r.type === 'team_chat') return typeof r.id === 'string'
  if (r.type === 'portal_chat') {
    return typeof r.contactId === 'string' && (r.accountId === null || typeof r.accountId === 'string')
  }
  return false
}

function safeParse(raw: string | null): RecentDestination[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRecentDestination)
  } catch {
    return []
  }
}

/** Stable identity for dedup — the two-destination shapes use their id; portal_chat uses its (contact, account) pair. */
function destinationKey(d: RecentDestination): string {
  return d.type === 'portal_chat' ? `portal_chat:${d.contactId}:${d.accountId ?? ''}` : `${d.type}:${d.id}`
}

/** Most-recent-first. Never throws (private browsing / storage disabled degrade to empty). */
export function getRecentDestinations(): RecentDestination[] {
  try {
    return safeParse(localStorage.getItem(STORAGE_KEY))
  } catch {
    return []
  }
}

/** Moves this destination to the front, deduped by its identity, capped at MAX_RECENTS. */
export function addRecentDestination(dest: RecentDestination): void {
  try {
    const key = destinationKey(dest)
    const existing = getRecentDestinations().filter((d) => destinationKey(d) !== key)
    const next = [dest, ...existing].slice(0, MAX_RECENTS)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // ignore — private mode, storage disabled, or a quota error; the
    // shortcut is a convenience, never something the send should fail over
  }
}
