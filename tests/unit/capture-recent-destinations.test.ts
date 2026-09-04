import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getRecentDestinations, addRecentDestination, REQUIRES_CONFIRMATION } from '@/lib/captures/recent-destinations'

/**
 * This suite runs under vitest's default `node` environment, which has no
 * real `localStorage` global (unlike a browser) — stub a minimal in-memory
 * implementation so the module's real read/write/JSON logic is exercised,
 * not just its catch-and-return-empty fallback path.
 */
function fakeLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => store.clear(),
  }
}

describe('recent destinations', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts empty', () => {
    expect(getRecentDestinations()).toEqual([])
  })

  it('adds a destination to the front', () => {
    addRecentDestination({ type: 'sticky_note', id: 'n1', label: 'My note' })
    expect(getRecentDestinations()).toEqual([{ type: 'sticky_note', id: 'n1', label: 'My note' }])
  })

  it('most recent first', () => {
    addRecentDestination({ type: 'sticky_note', id: 'n1', label: 'Note one' })
    addRecentDestination({ type: 'team_chat', id: 't1', label: 'general' })
    const recents = getRecentDestinations()
    expect(recents[0]).toEqual({ type: 'team_chat', id: 't1', label: 'general' })
    expect(recents[1]).toEqual({ type: 'sticky_note', id: 'n1', label: 'Note one' })
  })

  it('re-sending to the same destination moves it to the front instead of duplicating', () => {
    addRecentDestination({ type: 'sticky_note', id: 'n1', label: 'Note one' })
    addRecentDestination({ type: 'team_chat', id: 't1', label: 'general' })
    addRecentDestination({ type: 'sticky_note', id: 'n1', label: 'Note one (renamed)' })
    const recents = getRecentDestinations()
    expect(recents).toHaveLength(2)
    expect(recents[0]).toEqual({ type: 'sticky_note', id: 'n1', label: 'Note one (renamed)' })
    expect(recents[1]).toMatchObject({ id: 't1' })
  })

  it('caps at 3, dropping the oldest', () => {
    addRecentDestination({ type: 'sticky_note', id: 'n1', label: 'One' })
    addRecentDestination({ type: 'sticky_note', id: 'n2', label: 'Two' })
    addRecentDestination({ type: 'sticky_note', id: 'n3', label: 'Three' })
    addRecentDestination({ type: 'sticky_note', id: 'n4', label: 'Four' })
    const recents = getRecentDestinations()
    expect(recents).toHaveLength(3)
    expect(recents.map((r) => (r.type === 'portal_chat' ? r.contactId : r.id))).toEqual(['n4', 'n3', 'n2'])
  })

  it('a different type with the same id is treated as a distinct destination', () => {
    addRecentDestination({ type: 'sticky_note', id: 'same-id', label: 'Note' })
    addRecentDestination({ type: 'team_chat', id: 'same-id', label: 'Chat' })
    expect(getRecentDestinations()).toHaveLength(2)
  })

  it('ignores corrupted storage instead of throwing', () => {
    localStorage.setItem('td-capture-recent-destinations', '{not valid json')
    expect(getRecentDestinations()).toEqual([])
  })

  it('filters out malformed entries from storage (e.g. an old/foreign shape)', () => {
    localStorage.setItem(
      'td-capture-recent-destinations',
      JSON.stringify([{ type: 'sticky_note', id: 'ok', label: 'Fine' }, { type: 'bogus', id: 'x', label: 'y' }, { id: 'no-type' }]),
    )
    expect(getRecentDestinations()).toEqual([{ type: 'sticky_note', id: 'ok', label: 'Fine' }])
  })

  it('round-trips a portal_chat destination with its explicit contact/account pair', () => {
    addRecentDestination({ type: 'portal_chat', contactId: 'c1', accountId: 'a1', label: 'Jane Doe — Acme LLC' })
    expect(getRecentDestinations()).toEqual([{ type: 'portal_chat', contactId: 'c1', accountId: 'a1', label: 'Jane Doe — Acme LLC' }])
  })

  it('the same contact sent to two different companies are distinct recents, not a collision', () => {
    addRecentDestination({ type: 'portal_chat', contactId: 'c1', accountId: 'a1', label: 'Jane — Acme LLC' })
    addRecentDestination({ type: 'portal_chat', contactId: 'c1', accountId: 'a2', label: 'Jane — Other LLC' })
    expect(getRecentDestinations()).toHaveLength(2)
  })

  it('re-sending to the same contact+company pair moves it to the front instead of duplicating', () => {
    addRecentDestination({ type: 'portal_chat', contactId: 'c1', accountId: 'a1', label: 'Jane — Acme LLC' })
    addRecentDestination({ type: 'portal_chat', contactId: 'c1', accountId: 'a1', label: 'Jane — Acme LLC' })
    expect(getRecentDestinations()).toHaveLength(1)
  })

  it('filters out a malformed portal_chat entry missing contactId', () => {
    localStorage.setItem(
      'td-capture-recent-destinations',
      JSON.stringify([{ type: 'portal_chat', accountId: 'a1', label: 'Broken' }]),
    )
    expect(getRecentDestinations()).toEqual([])
  })

  it('REQUIRES_CONFIRMATION marks only portal_chat as needing confirmation', () => {
    expect(REQUIRES_CONFIRMATION.sticky_note).toBe(false)
    expect(REQUIRES_CONFIRMATION.team_chat).toBe(false)
    expect(REQUIRES_CONFIRMATION.portal_chat).toBe(true)
  })
})
