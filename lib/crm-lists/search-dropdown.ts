/**
 * The search dropdown under the Contacts and Accounts list search boxes (Antonio 2026-11-15: "when I search a contact I want the
 * dropdown while typing"). Pure and client-safe: when to search, how the highlight moves, and what each result row says. The data
 * comes from the SAME search the global search uses (GET /api/search), so the two can never disagree about who matches.
 */
import type { EnhancedSearchResult } from '@/lib/types'

export const SEARCH_MIN_CHARS = 2
export const SEARCH_DEBOUNCE_MS = 200
export const SEARCH_MAX_ROWS = 8
/** How long typing must pause before the LIST under the box refreshes to what is typed (the dropdown answers a little sooner). */
export const LIVE_LIST_DEBOUNCE_MS = 300

/** The text to search for, or null while it is too short to be worth a request (the API itself answers nothing under 2 characters). */
export function searchableQuery(raw: string): string | null {
  const q = raw.trim()
  return q.length >= SEARCH_MIN_CHARS ? q : null
}

/** Which row is highlighted after an arrow key: -1 = none, down from the last wraps to the first, up from none goes to the last. */
export function nextHighlight(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1
  if (current < 0) return delta === 1 ? 0 : count - 1
  return (current + delta + count) % count
}

export interface DropdownRow { id: string; title: string; detail: string; href: string }

/** First `max` names, then "+N" for the rest. */
function nameList(names: string[], max: number): string {
  const clean = names.map((n) => n.trim()).filter(Boolean)
  if (clean.length <= max) return clean.join(', ')
  return `${clean.slice(0, max).join(', ')} +${clean.length - max}`
}

/**
 * The rows to show: only results of the wanted kind, at most SEARCH_MAX_ROWS.
 * A person's line = email (else phone) · their companies. A company's line = status · state · its people.
 */
export function dropdownRows(results: EnhancedSearchResult[], type: 'contact' | 'account'): DropdownRow[] {
  return results
    .filter((r) => r.type === type)
    .slice(0, SEARCH_MAX_ROWS)
    .map((r) => {
      let detail: string
      if (type === 'contact') {
        const reach = r.preview.email || r.preview.phone || ''
        const companies = nameList((r.preview.companies ?? []).map((c) => c.name), 2)
        detail = [reach, companies].filter(Boolean).join(' · ')
      } else {
        const people = nameList((r.preview.contacts ?? []).map((c) => c.name), 2)
        detail = [r.subtitle ?? '', people].filter(Boolean).join(' · ')
      }
      return { id: r.id, title: r.title, detail, href: r.href }
    })
}

/**
 * The list refreshes itself while you type, by changing the address's search text. Each refresh comes back from the server a moment
 * later — and a slow one can arrive AFTER you typed more. Such an echo of our own earlier keystroke must not overwrite the box (that
 * would erase what you just typed). When only the search text differs from what we last sent:
 *  - "settled": it is exactly what we last sent (the latest refresh has arrived);
 *  - "stale-echo": it is an older value we sent ourselves — ignore it;
 *  - "external": anything else (browser Back, a link) — the box should follow the address.
 */
export function classifyIncomingQuery(incoming: string, lastSent: string, sentSoFar: ReadonlySet<string>): 'settled' | 'stale-echo' | 'external' {
  if (incoming === lastSent) return 'settled'
  return sentSoFar.has(incoming) ? 'stale-echo' : 'external'
}
