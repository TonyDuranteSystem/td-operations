/**
 * Portal Chats list chips: All · Unread · What's New · Chats · Pinned (lib/portal-chats/list-filter).
 * Antonio 2026-11-10: add "Chats" and "Pinned"; the list opens on "Chats".
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import {
  DEFAULT_LIST_FILTER,
  LIST_FILTER_CHIPS,
  buildPeopleThreadKeySet,
  loadPeopleThreadKeys,
  matchesListFilter,
  orderThreadsForChip,
  threadHasPeopleMessages,
  type FilterableThread,
} from '@/lib/portal-chats/list-filter'
import type { WhatsNewCounts } from '@/lib/portal-chats/sort-threads'

const thread = (over: Partial<FilterableThread> = {}): FilterableThread => ({
  account_id: 'acc-1',
  contact_id: null,
  unread_count: 0,
  last_message_at: '2026-11-10T10:00:00Z',
  ...over,
})

describe('chips', () => {
  it('are in the order Antonio asked for', () => {
    expect(LIST_FILTER_CHIPS.map(([, label]) => label)).toEqual(['All', 'Unread', "What's New", 'Chats', 'Pinned'])
    expect(LIST_FILTER_CHIPS.map(([key]) => key)).toEqual(['all', 'unread', 'whatsnew', 'chats', 'pinned'])
  })

  it('open on Chats, not All', () => {
    expect(DEFAULT_LIST_FILTER).toBe('chats')
  })
})

describe('matchesListFilter', () => {
  const counts: WhatsNewCounts = { by_account: { 'acc-wn': 2 }, by_contact: { 'con-wn': 1 } }

  it('All keeps everything', () => {
    expect(matchesListFilter(thread({ has_people_messages: false }), 'all')).toBe(true)
  })

  it('Unread keeps only conversations with unread client messages', () => {
    expect(matchesListFilter(thread({ unread_count: 3 }), 'unread')).toBe(true)
    expect(matchesListFilter(thread({ unread_count: 0 }), 'unread')).toBe(false)
  })

  it("What's New keeps account and contact conversations with unhandled notes", () => {
    expect(matchesListFilter(thread({ account_id: 'acc-wn' }), 'whatsnew', counts)).toBe(true)
    expect(matchesListFilter(thread({ account_id: null, contact_id: 'con-wn' }), 'whatsnew', counts)).toBe(true)
    expect(matchesListFilter(thread({ account_id: 'acc-other' }), 'whatsnew', counts)).toBe(false)
    expect(matchesListFilter(thread(), 'whatsnew', null)).toBe(false)
  })

  it('Chats keeps conversations where a person wrote and drops notice-only ones', () => {
    expect(matchesListFilter(thread({ has_people_messages: true }), 'chats')).toBe(true)
    expect(matchesListFilter(thread({ has_people_messages: false }), 'chats')).toBe(false)
  })

  it('Chats leaves out the conversations that have their own chip: pinned ones and ones with an unhandled client action', () => {
    expect(matchesListFilter(thread({ has_people_messages: true, is_pinned: true }), 'chats')).toBe(false)
    expect(matchesListFilter(thread({ account_id: 'acc-wn', has_people_messages: true }), 'chats', counts)).toBe(false)
    expect(matchesListFilter(thread({ account_id: null, contact_id: 'con-wn', has_people_messages: true }), 'chats', counts)).toBe(false)
    // …and a plain chat stays, also when What's New counts exist for other conversations
    expect(matchesListFilter(thread({ account_id: 'acc-plain', has_people_messages: true }), 'chats', counts)).toBe(true)
    // they are still under their own chips
    expect(matchesListFilter(thread({ is_pinned: true }), 'pinned')).toBe(true)
    expect(matchesListFilter(thread({ account_id: 'acc-wn' }), 'whatsnew', counts)).toBe(true)
  })

  it('Chats keeps a conversation whose flag is unknown (old answer / function not installed) — never an empty default list', () => {
    expect(matchesListFilter(thread({ has_people_messages: undefined }), 'chats')).toBe(true)
  })

  it('Pinned keeps only pinned conversations', () => {
    expect(matchesListFilter(thread({ is_pinned: true }), 'pinned')).toBe(true)
    expect(matchesListFilter(thread({ is_pinned: false }), 'pinned')).toBe(false)
    expect(matchesListFilter(thread(), 'pinned')).toBe(false)
  })

  it('an unread conversation always has a person-written message, so it is never hidden by Chats', () => {
    // unread_count only counts sender_type 'client' rows; the database flag counts client AND admin rows.
    expect(matchesListFilter(thread({ unread_count: 2, has_people_messages: true }), 'chats')).toBe(true)
  })
})

describe('orderThreadsForChip', () => {
  const t = (id: string, at: string, over: Partial<FilterableThread> = {}) => ({ ...thread({ account_id: id, last_message_at: at, ...over }), id })
  const list = [
    t('old-plain', '2026-11-01T10:00:00Z'),
    t('new-plain', '2026-11-09T10:00:00Z'),
    t('pinned-old', '2026-10-01T10:00:00Z', { is_pinned: true }),
    t('unread-mid', '2026-11-05T10:00:00Z', { unread_count: 2 }),
  ]

  it('Chats is a plain list, newest first — nothing floats to the top', () => {
    expect(orderThreadsForChip(list, 'chats').map(x => x.id)).toEqual(['new-plain', 'unread-mid', 'old-plain', 'pinned-old'])
  })

  it('every other chip keeps the usual order: pinned first, then what needs a look, then newest first', () => {
    expect(orderThreadsForChip(list, 'all').map(x => x.id)).toEqual(['pinned-old', 'unread-mid', 'new-plain', 'old-plain'])
    expect(orderThreadsForChip(list, 'unread').map(x => x.id)).toEqual(['pinned-old', 'unread-mid', 'new-plain', 'old-plain'])
  })

  it('does not change the list it is given', () => {
    const before = list.map(x => x.id)
    orderThreadsForChip(list, 'chats')
    expect(list.map(x => x.id)).toEqual(before)
  })
})

describe('people-thread keys', () => {
  const keys = buildPeopleThreadKeySet([
    { contact_id: null, account_id: 'acc-multi' },
    { contact_id: 'con-1', account_id: null },
  ])

  it('flags an account-level conversation by its account', () => {
    expect(threadHasPeopleMessages({ account_id: 'acc-multi', contact_id: null }, keys)).toBe(true)
    expect(threadHasPeopleMessages({ account_id: 'acc-none', contact_id: null }, keys)).toBe(false)
  })

  it('flags a contact-level conversation by its person', () => {
    expect(threadHasPeopleMessages({ account_id: null, contact_id: 'con-1' }, keys)).toBe(true)
    expect(threadHasPeopleMessages({ account_id: null, contact_id: 'con-2' }, keys)).toBe(false)
  })

  it('never lets a person key match a company id (or the other way round)', () => {
    expect(threadHasPeopleMessages({ account_id: 'con-1', contact_id: null }, keys)).toBe(false)
    expect(threadHasPeopleMessages({ account_id: null, contact_id: 'acc-multi' }, keys)).toBe(false)
  })

  it('a conversation with neither id has no people messages', () => {
    expect(threadHasPeopleMessages({ account_id: null, contact_id: null }, keys)).toBe(false)
  })

  it('handles an empty answer', () => {
    expect(buildPeopleThreadKeySet([]).size).toBe(0)
  })
})

describe('loadPeopleThreadKeys', () => {
  // The database client's calls are thenables (no .catch) — the fake mirrors that on purpose.
  const thenable = <T,>(value: T): PromiseLike<T> => ({ then: (ok, bad) => Promise.resolve(value).then(ok, bad) })

  it('turns the database answer into the key set', async () => {
    const keys = await loadPeopleThreadKeys({ rpc: () => thenable({ data: [{ contact_id: null, account_id: 'a1' }, { contact_id: 'c1', account_id: null }], error: null }) })
    expect(keys && Array.from(keys).sort()).toEqual(['account:a1', 'contact:c1'])
  })

  it('asks for the right function', async () => {
    let asked = ''
    await loadPeopleThreadKeys({ rpc: fn => { asked = fn; return thenable({ data: [], error: null }) } })
    expect(asked).toBe('get_portal_chat_people_thread_keys')
  })

  it('returns null (unknown) when the function is missing — the list must still load', async () => {
    const keys = await loadPeopleThreadKeys({ rpc: () => thenable({ data: null, error: { message: 'Could not find the function' } }) })
    expect(keys).toBeNull()
  })

  it('returns null when the call itself throws', async () => {
    const keys = await loadPeopleThreadKeys({ rpc: () => { throw new Error('network down') } })
    expect(keys).toBeNull()
  })

  it('returns null when the answer is not a list', async () => {
    const keys = await loadPeopleThreadKeys({ rpc: () => thenable({ data: { nope: true }, error: null }) })
    expect(keys).toBeNull()
  })
})

describe('wiring (source guards — the project has no jsdom)', () => {
  const route = readFileSync('app/api/portal/chat/threads/route.ts', 'utf8')
  const page = readFileSync('app/(dashboard)/portal-chats/page.tsx', 'utf8')
  const migration = readFileSync('scripts/migrations/20261110-1200-portal-chat-people-thread-keys.sql', 'utf8')

  it('the threads route asks the database function and falls back to "unknown" when it is missing', () => {
    expect(route).toContain('loadPeopleThreadKeys(supabaseAdmin as unknown as PeopleKeysClient)')
    expect(route).not.toMatch(/\.rpc\([^)]*\)[^;\n]*\.catch\(/) // database calls are thenables: no .catch (broke the first version)
    expect(route).toContain('has_people_messages: peopleKeys ? threadHasPeopleMessages(r, peopleKeys) : undefined')
  })

  it('the page draws its chips from the shared list, opens on the shared default, and filters through the shared rule', () => {
    expect(page).toContain('LIST_FILTER_CHIPS.map(')
    expect(page).toContain('useState<ListFilter>(DEFAULT_LIST_FILTER)')
    expect(page).toContain('matchesListFilter(t, listFilter, whatsNewCounts)')
    expect(page).toContain('orderThreadsForChip(threads ?? [], listFilter, whatsNewCounts)')
  })

  it('the page offers a way out of an empty chip', () => {
    expect(page).toContain('data-testid="chat-list-empty"')
    expect(page).toContain('Show all conversations')
  })

  it('the migration counts client and team messages only, skips deleted ones, and is locked to the service role', () => {
    expect(migration).toContain("pm.sender_type IN ('client', 'admin')")
    expect(migration).toContain('pm.deleted_at IS NULL')
    expect(migration).toContain('REVOKE EXECUTE ON FUNCTION public.get_portal_chat_people_thread_keys() FROM PUBLIC, anon, authenticated')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.get_portal_chat_people_thread_keys() TO service_role')
  })

  it('the migration has an UNDO file', () => {
    const undo = readFileSync('scripts/migrations/20261110-1200-portal-chat-people-thread-keys.UNDO.sql', 'utf8')
    expect(undo).toContain('DROP FUNCTION IF EXISTS public.get_portal_chat_people_thread_keys()')
  })
})
