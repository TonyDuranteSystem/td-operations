import { describe, it, expect } from 'vitest'
import {
  STANDARD_GROUPS,
  standardLayout,
  layoutFromLegacyOrder,
  parseLayout,
  reconcileLayout,
  resolveLayout,
  visibleRows,
  flattenVisible,
  containerOf,
  movePage,
  moveGroup,
  reorder,
  checkGroupName,
  createGroup,
  renameGroup,
  deleteGroup,
  newGroupId,
  isGroupId,
  MAX_GROUPS,
  pickLayoutOnLoad,
  type MenuLayout,
  type GroupRow,
} from '@/lib/nav/menu-layout'
import { isNavItemActive, onWhatsappView } from '@/lib/nav/nav-active'

const PAGES = [
  'td-talk', 'home', 'research', 'notes', 'inbox', 'whatsapp', 'marketing-chat', 'portal-chats', 'team-chat', 'dev-board',
  'storage', 'leads', 'marketing', 'contacts', 'accounts', 'tools', 'finance', 'owner', 'tax', 'calendar',
]

const ids = (l: MenuLayout) => l.rows.flatMap(r => (r.type === 'page' ? [r.id] : r.children))
const group = (l: MenuLayout, id: string) => l.rows.find((r): r is GroupRow => r.type === 'group' && r.id === id)!

describe('standardLayout', () => {
  const l = standardLayout(PAGES)
  it('holds every page exactly once', () => {
    expect([...ids(l)].sort()).toEqual([...PAGES].sort())
  })
  it("builds the three groups Antonio asked for, in his order", () => {
    expect(group(l, 'g-social').name).toBe('TD Social')
    expect(group(l, 'g-social').children).toEqual(['td-talk', 'inbox', 'marketing-chat', 'whatsapp', 'team-chat', 'portal-chats'])
    expect(group(l, 'g-accounting').children).toEqual(['finance', 'owner'])
    expect(group(l, 'g-network').children).toEqual(['leads', 'contacts', 'accounts'])
  })
  it('stands each group where its first member stood', () => {
    expect(l.rows[0].id).toBe('g-social')
    const order = l.rows.map(r => r.id)
    expect(order.indexOf('g-network')).toBe(order.indexOf('marketing') - 1)
  })
  it('skips pages that do not exist and drops a group that would be empty', () => {
    const small = standardLayout(['home', 'finance'])
    expect(small.rows.map(r => r.id)).toEqual(['home', 'g-accounting'])
    expect(group(small, 'g-accounting').children).toEqual(['finance'])
  })
  it('standard group members are all real page ids elsewhere in the file (no page id starts with the group prefix)', () => {
    for (const p of PAGES) expect(isGroupId(p)).toBe(false)
    expect(STANDARD_GROUPS.every(g => isGroupId(g.id))).toBe(true)
  })
})

describe('layoutFromLegacyOrder', () => {
  it('keeps the old order for the main list and puts each group where its earliest member was', () => {
    const legacy = ['home', 'notes', 'leads', 'td-talk', 'tools', 'research']
    const l = layoutFromLegacyOrder(legacy, PAGES)
    const order = l.rows.map(r => r.id)
    // rows the old list knew come out in the OLD order: home, notes, g-network (leads), g-social (td-talk), tools, research
    const known = order.filter(id => ['home', 'notes', 'g-network', 'g-social', 'tools', 'research'].includes(id))
    expect(known).toEqual(['home', 'notes', 'g-network', 'g-social', 'tools', 'research'])
    // rows the old list never heard of (dev-board, storage) keep their standard slot instead of jumping around
    expect(order.indexOf('dev-board')).toBe(standardLayout(PAGES).rows.map(r => r.id).indexOf('dev-board'))
    expect([...ids(l)].sort()).toEqual([...PAGES].sort())
  })
  it('with an empty old order equals the standard layout', () => {
    expect(layoutFromLegacyOrder([], PAGES)).toEqual(standardLayout(PAGES))
  })
})

describe('parseLayout / reconcileLayout / resolveLayout', () => {
  it('rejects anything that is not a layout', () => {
    for (const bad of [null, undefined, 5, 'x', {}, { v: 2, rows: [] }, { v: 1, rows: 'a' }, { v: 1, rows: [{ type: 'page', id: 'Bad Id' }] },
      { v: 1, rows: [{ type: 'page', id: 'g-oops' }] }, { v: 1, rows: [{ type: 'group', id: 'plain', name: 'X', children: [] }] },
      { v: 1, rows: [{ type: 'group', id: 'g-a', name: '   ', children: [] }] },
      { v: 1, rows: [{ type: 'group', id: 'g-a', name: 'A', children: ['g-b'] }] }]) {
      expect(parseLayout(bad)).toBeNull()
    }
  })
  it('accepts a good one and trims a long name', () => {
    const l = parseLayout({ v: 1, rows: [{ type: 'group', id: 'g-a', name: '  Very long group name that goes on and on  ', children: ['home'] }] })
    expect(l).not.toBeNull()
    expect((l!.rows[0] as GroupRow).name.length).toBeLessThanOrEqual(24)
  })
  it('refuses an oversized layout', () => {
    const rows = Array.from({ length: 399 }, (_, i) => ({ type: 'page', id: 'p' + 'x'.repeat(44) + i }))
    expect(parseLayout({ v: 1, rows })).toBeNull()
  })
  it('reconcile drops unknown pages and repeats, and brings back missing pages', () => {
    const saved: MenuLayout = { v: 1, rows: [
      { type: 'page', id: 'home' }, { type: 'page', id: 'gone' }, { type: 'page', id: 'home' },
      { type: 'group', id: 'g-mine', name: 'Mine', children: ['notes', 'gone', 'home'] },
    ] }
    const r = reconcileLayout(saved, ['home', 'notes', 'tools'])
    expect([...ids(r)].sort()).toEqual(['home', 'notes', 'tools'])
    expect(group(r, 'g-mine').children).toEqual(['notes']) // 'home' was already placed first
    expect(r.rows[r.rows.length - 1]).toEqual({ type: 'page', id: 'tools' })
  })
  it('a page added to the code later goes into its standard group when the person still has it', () => {
    const saved = standardLayout(PAGES.filter(p => p !== 'whatsapp'))
    const r = reconcileLayout(saved, PAGES)
    expect(group(r, 'g-social').children).toContain('whatsapp')
  })
  it('...and to the end of the main list when the person deleted that group', () => {
    const saved = deleteGroup(standardLayout(PAGES.filter(p => p !== 'whatsapp')), 'g-social')
    const r = reconcileLayout(saved, PAGES)
    expect(containerOf(r, 'whatsapp')).toBe('root')
    expect(r.rows[r.rows.length - 1]).toEqual({ type: 'page', id: 'whatsapp' })
  })
  it('caps the number of groups by dissolving the extras into the main list', () => {
    const rows: MenuLayout['rows'] = Array.from({ length: MAX_GROUPS + 2 }, (_, i) => ({ type: 'group', id: `g-x${i}`, name: `G${i}`, children: [`p${i}`] }))
    const r = reconcileLayout({ v: 1, rows }, rows.map((_, i) => `p${i}`))
    expect(r.rows.filter(x => x.type === 'group')).toHaveLength(MAX_GROUPS)
    expect(ids(r)).toHaveLength(MAX_GROUPS + 2)
  })
  it('resolveLayout falls back to the standard layout for junk', () => {
    expect(resolveLayout('nonsense', PAGES)).toEqual(standardLayout(PAGES))
  })
})

describe('visibleRows (who sees what — never decided by the group)', () => {
  const l = standardLayout(PAGES)
  const luca = (id: string) => id !== 'owner' && id !== 'marketing-chat' && id !== 'marketing'
  const antonio = () => true
  it('a group whose pages are all hidden disappears', () => {
    const only = (id: string) => id === 'home'
    expect(visibleRows(l, only, true).map(r => r.id)).toEqual(['home'])
  })
  it("a group with one visible page shows as that plain page (Luca's Accounting is Finance)", () => {
    const rows = visibleRows(l, luca, true)
    expect(rows.find(r => r.id === 'g-accounting')).toBeUndefined()
    expect(rows.find(r => r.id === 'finance')).toEqual({ type: 'page', id: 'finance' })
  })
  it('a one-page group the person made on purpose stays a group (only permission-reduced groups collapse)', () => {
    const made = createGroup(l, 'Mine')
    if (!made.ok) throw new Error('create failed')
    const placed = movePage(made.layout, 'home', made.id)
    const rows = visibleRows(placed, antonio, true)
    const g = rows.find(r => r.id === made.id)
    expect(g && g.type).toBe('group')
    expect((g as { children: string[] }).children).toEqual(['home'])
  })
  it('the editor does not collapse a single', () => {
    const rows = visibleRows(l, luca, false)
    const acc = rows.find(r => r.id === 'g-accounting')!
    expect(acc.type).toBe('group')
    expect((acc as { children: string[] }).children).toEqual(['finance'])
  })
  it("Luca's TD Social does not contain Antonio's Marketing Chat even though it sits in the group", () => {
    const social = visibleRows(l, luca, true).find(r => r.id === 'g-social') as { children: string[] }
    expect(social.children).not.toContain('marketing-chat')
    expect(social.children).toContain('whatsapp')
  })
  it('Antonio sees everything', () => {
    const social = visibleRows(l, antonio, true).find(r => r.id === 'g-social') as { children: string[] }
    expect(social.children).toContain('marketing-chat')
  })
  it('a group the person made and left empty still shows (so they can fill it)', () => {
    const c = createGroup(l, 'Mine')
    if (!c.ok) throw new Error('create failed')
    const g = visibleRows(c.layout, antonio, true).find(r => r.id === c.id)
    expect(g && g.type === 'group' && g.empty).toBe(true)
  })
  it('flattenVisible lists pages in menu order for the windows launcher', () => {
    const flat = flattenVisible(l, luca)
    expect(flat.indexOf('td-talk')).toBeLessThan(flat.indexOf('home'))
    expect(flat).not.toContain('owner')
  })
})

describe('editing', () => {
  const base = standardLayout(PAGES)
  it('movePage out of a group to the main list, before a neighbour', () => {
    const l = movePage(base, 'whatsapp', 'root', { before: 'home' })
    expect(containerOf(l, 'whatsapp')).toBe('root')
    const order = l.rows.map(r => r.id)
    expect(order.indexOf('whatsapp')).toBe(order.indexOf('home') - 1)
    expect(group(l, 'g-social').children).not.toContain('whatsapp')
  })
  it('movePage into a group at the end, and between two pages', () => {
    const a = movePage(base, 'home', 'g-network')
    expect(group(a, 'g-network').children).toEqual(['leads', 'contacts', 'accounts', 'home'])
    const b = movePage(base, 'home', 'g-network', { after: 'leads' })
    expect(group(b, 'g-network').children).toEqual(['leads', 'home', 'contacts', 'accounts'])
  })
  it('movePage never loses or duplicates a page, and ignores bad targets', () => {
    expect(ids(movePage(base, 'home', 'g-network')).sort()).toEqual([...PAGES].sort())
    expect(movePage(base, 'home', 'g-nope')).toBe(base)
    expect(movePage(base, 'nope', 'root')).toBe(base)
    expect(movePage(base, 'g-social', 'root')).toBe(base)
  })
  it('moveGroup reorders groups among the main list', () => {
    const l = moveGroup(base, 'g-network', { before: 'home' })
    const order = l.rows.map(r => r.id)
    expect(order.indexOf('g-network')).toBe(order.indexOf('home') - 1)
    expect(ids(l).sort()).toEqual([...PAGES].sort())
  })
  it('reorder: same container moves down = after, up = before', () => {
    const down = reorder(base, 'td-talk', 'team-chat')
    expect(group(down, 'g-social').children).toEqual(['inbox', 'marketing-chat', 'whatsapp', 'team-chat', 'td-talk', 'portal-chats'])
    const up = reorder(base, 'team-chat', 'inbox')
    expect(group(up, 'g-social').children).toEqual(['td-talk', 'team-chat', 'inbox', 'marketing-chat', 'whatsapp', 'portal-chats'])
  })
  it('reorder: dropping a page on a page of another container puts it before that page there', () => {
    const l = reorder(base, 'home', 'contacts')
    expect(group(l, 'g-network').children).toEqual(['leads', 'home', 'contacts', 'accounts'])
  })
  it('reorder: dropping a page on a group puts it inside at the end', () => {
    const l = reorder(base, 'home', 'g-accounting')
    expect(group(l, 'g-accounting').children).toEqual(['finance', 'owner', 'home'])
  })
  it('reorder: a group dropped on a page inside another group lands next to that group (before it when moving up)', () => {
    const l = reorder(base, 'g-network', 'whatsapp')
    const order = l.rows.map(r => r.id)
    expect(order.indexOf('g-network')).toBe(order.indexOf('g-social') - 1)
    const down = reorder(base, 'g-social', 'contacts')
    const order2 = down.rows.map(r => r.id)
    expect(order2.indexOf('g-social')).toBe(order2.indexOf('g-network') + 1)
  })
  it("reorder: dropping a page on the group it is ALREADY in (name bar, a gap, the padding) leaves it where it is — not at the end", () => {
    expect(reorder(base, 'inbox', 'g-social')).toBe(base)
    const l = reorder(base, 'home', 'g-network') // from outside it still goes in, at the end
    expect(group(l, 'g-network').children).toEqual(['leads', 'contacts', 'accounts', 'home'])
  })
  it('reorder with the same id changes nothing', () => {
    expect(reorder(base, 'home', 'home')).toBe(base)
  })
})

describe('groups: create, rename, delete', () => {
  const base = standardLayout(PAGES)
  it('creates an empty group at the top with a fresh id', () => {
    const r = createGroup(base, '  Daily  ')
    if (!r.ok) throw new Error('should create')
    expect(r.layout.rows[0]).toEqual({ type: 'group', id: r.id, name: 'Daily', children: [] })
    expect(isGroupId(r.id)).toBe(true)
    expect(ids(r.layout).sort()).toEqual([...PAGES].sort())
  })
  it('refuses an empty name, a repeated name (any capitals) and too many groups', () => {
    expect(createGroup(base, '   ').ok).toBe(false)
    expect(createGroup(base, 'td social').ok).toBe(false)
    let l = base
    for (let i = base.rows.filter(r => r.type === 'group').length; i < MAX_GROUPS; i++) {
      const r = createGroup(l, `Extra ${i}`)
      if (!r.ok) throw new Error('should create')
      l = r.layout
    }
    expect(createGroup(l, 'One too many').ok).toBe(false)
  })
  it('names are kept to 24 characters', () => {
    const c = checkGroupName(base, 'x'.repeat(60))
    expect(c.ok && c.name.length).toBe(24)
  })
  it('renames, allowing the same name for the same group', () => {
    const ok = renameGroup(base, 'g-network', 'People')
    expect(ok.ok && group(ok.layout, 'g-network').name).toBe('People')
    expect(renameGroup(base, 'g-network', 'Network').ok).toBe(true)
    expect(renameGroup(base, 'g-network', 'Accounting').ok).toBe(false)
    expect(renameGroup(base, 'g-gone', 'X').ok).toBe(false)
  })
  it("deleting a group puts its pages back in the main list, in the group's place", () => {
    const l = deleteGroup(base, 'g-accounting')
    const order = l.rows.map(r => r.id)
    expect(order).toContain('finance')
    expect(order.indexOf('owner')).toBe(order.indexOf('finance') + 1)
    expect(l.rows.some(r => r.id === 'g-accounting')).toBe(false)
    expect(ids(l).sort()).toEqual([...PAGES].sort())
  })
  it('newGroupId never reuses an id', () => {
    const l = createGroup(base, 'A')
    if (!l.ok) throw new Error('x')
    const fixed = () => 0.5
    const first = newGroupId(l.layout, fixed)
    const withIt: MenuLayout = { v: 1, rows: [...l.layout.rows, { type: 'group', id: first, name: 'B', children: [] }] }
    expect(newGroupId(withIt, fixed)).not.toBe(first)
  })
})

describe('isNavItemActive', () => {
  const inbox = { id: 'inbox', href: '/inbox' }
  const wa = { id: 'whatsapp', href: '/inbox?channel=whatsapp' }
  it('Inbox and WhatsApp never light together', () => {
    expect(isNavItemActive(inbox, '/inbox', '')).toBe(true)
    expect(isNavItemActive(wa, '/inbox', '')).toBe(false)
    expect(isNavItemActive(inbox, '/inbox', '?channel=whatsapp')).toBe(false)
    expect(isNavItemActive(wa, '/inbox', '?channel=whatsapp')).toBe(true)
  })
  it('an open WhatsApp chat lights WhatsApp, an open email lights Inbox', () => {
    expect(isNavItemActive(wa, '/inbox', '?thread=whatsapp:123')).toBe(true)
    expect(isNavItemActive(inbox, '/inbox', '?thread=whatsapp:123')).toBe(false)
    expect(isNavItemActive(inbox, '/inbox', '?thread=gmail:abc&mailbox=support')).toBe(true)
  })
  it('other pages light on their own path, home only on /', () => {
    expect(isNavItemActive({ id: 'home', href: '/' }, '/', '')).toBe(true)
    expect(isNavItemActive({ id: 'home', href: '/' }, '/accounts', '')).toBe(false)
    expect(isNavItemActive({ id: 'accounts', href: '/accounts' }, '/accounts/abc', '')).toBe(true)
    expect(isNavItemActive({ id: 'calendar', href: '/new-calendar' }, '/calendar', '')).toBe(true)
    expect(isNavItemActive({ id: 'marketing', href: '/marketing-leads' }, '/marketing/chat', '')).toBe(false)
  })
  it('onWhatsappView is false off the inbox', () => {
    expect(onWhatsappView('/accounts', '?channel=whatsapp')).toBe(false)
  })
})

describe('pickLayoutOnLoad — which layout the menu starts from', () => {
  const standard = standardLayout(PAGES)
  const mine = createGroup(standard, 'Mine')
  if (!mine.ok || !mine.layout) throw new Error('setup')
  const account = movePage(mine.layout, 'home', mine.id!) // what the account has
  const edited = movePage(account, 'notes', mine.id!) // an edit made here after that
  const legacy = ['notes', 'home', 'leads']

  it('an edit that never reached the account (failed save) wins after a reload, and is sent again', () => {
    const r = pickLayoutOnLoad({ status: 'saved', server: account, local: { layout: edited, synced: false }, legacy: null, pageIds: PAGES })
    expect(r.layout).toEqual(reconcileLayout(edited, PAGES))
    expect(r.resend).toBe(true)
  })
  it("otherwise the account's copy wins over this browser's older copy", () => {
    const r = pickLayoutOnLoad({ status: 'saved', server: account, local: { layout: standard, synced: true }, legacy, pageIds: PAGES })
    expect(r.layout).toEqual(reconcileLayout(account, PAGES))
    expect(r.resend).toBe(false)
  })
  it('nothing saved on the account: a copy that was already synced means it was reset elsewhere — ignore it, carry over the old order', () => {
    const r = pickLayoutOnLoad({ status: 'none', server: null, local: { layout: edited, synced: true }, legacy, pageIds: PAGES })
    expect(r.layout).toEqual(layoutFromLegacyOrder(legacy, PAGES))
    expect(r.resend).toBe(false)
  })
  it('nothing saved and an unsynced copy here (the table may not exist yet): use it and send it', () => {
    const r = pickLayoutOnLoad({ status: 'none', server: null, local: { layout: edited, synced: false }, legacy, pageIds: PAGES })
    expect(r.layout).toEqual(reconcileLayout(edited, PAGES))
    expect(r.resend).toBe(true)
  })
  it('nothing anywhere: the standard layout', () => {
    const r = pickLayoutOnLoad({ status: 'none', server: null, local: null, legacy: null, pageIds: PAGES })
    expect(r.layout).toEqual(standard)
    expect(r.resend).toBe(false)
  })
  it('the account could not be read: show what this browser has, but NEVER send (the real saved layout may exist)', () => {
    const withLocal = pickLayoutOnLoad({ status: 'unavailable', server: null, local: { layout: edited, synced: false }, legacy, pageIds: PAGES })
    expect(withLocal.layout).toEqual(reconcileLayout(edited, PAGES))
    expect(withLocal.resend).toBe(false)
    const without = pickLayoutOnLoad({ status: 'unavailable', server: null, local: null, legacy: null, pageIds: PAGES })
    expect(without.layout).toEqual(standard)
    expect(without.resend).toBe(false)
  })
  it('a stale local copy is made current: pages added later come back, removed ones go', () => {
    const old = standardLayout(PAGES.filter(p => p !== 'whatsapp'))
    const r = pickLayoutOnLoad({ status: 'none', server: null, local: { layout: old, synced: false }, legacy: null, pageIds: PAGES })
    expect(ids(r.layout).sort()).toEqual([...PAGES].sort())
  })
})
