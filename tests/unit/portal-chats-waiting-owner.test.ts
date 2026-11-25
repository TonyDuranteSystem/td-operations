/**
 * "Waiting on us" owners (Antonio, 2026-11-25, dev job 40b5fd59): every conversation the client is waiting on us for belongs to one team member (or
 * nobody yet); the card under the chip lists them with a filter per person and opens on the viewer's own. The same afternoon ("build Waiting for
 * client owners") the conversations WE wait on the client for got an owner too: the team member who follows them up.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  decideOwnerForMark,
  defaultOwnerFilter,
  matchesOwnerFilter,
  OWNER_PICKER_HIDDEN_EMAILS,
  ownerCounts,
  ownerPickerMembers,
  staffInitials,
  tidyStaffName,
  waitingForCard,
  waitingOwnerOf,
  waitingSinceOf,
  waitingUsForCard,
  type WaitingStaff,
} from '@/lib/portal-chats/waiting-owner'
import { LIST_FILTER_CHIPS } from '@/lib/portal-chats/list-filter'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const STAFF: WaitingStaff[] = [
  { id: 'u-antonio', name: 'Antonio Durante', initials: 'AD' },
  { id: 'u-luca', name: 'Luca Degasper', initials: 'LD' },
  { id: 'u-jodi', name: 'Jodi', initials: 'J' },
]
const STAFF_IDS = STAFF.map(s => s.id)

describe('names on the card', () => {
  it('an email-style login name becomes a readable name; a real full name is left exactly as written', () => {
    expect(tidyStaffName('antonio.durante')).toBe('Antonio Durante')
    expect(tidyStaffName('luca_degasper')).toBe('Luca Degasper')
    expect(tidyStaffName('Luca Degasper')).toBe('Luca Degasper')
    expect(tidyStaffName('Jodi')).toBe('Jodi')
    expect(tidyStaffName('QA Staff')).toBe('QA Staff')
  })
  it('an empty name never shows blank', () => {
    expect(tidyStaffName('')).toBe('Team member')
    expect(tidyStaffName(null)).toBe('Team member')
    expect(tidyStaffName(undefined)).toBe('Team member')
  })
  it('initials are the first letters of the first two words', () => {
    expect(staffInitials('antonio.durante')).toBe('AD')
    expect(staffInitials('Luca Degasper')).toBe('LD')
    expect(staffInitials('Jodi')).toBe('J')
    expect(staffInitials('Maria de la Cruz')).toBe('MD')
  })
})

describe('the card opens on the viewer\'s own conversations', () => {
  it('a team member sees their own; someone not on the team list sees everyone\'s', () => {
    expect(defaultOwnerFilter('u-luca', STAFF)).toBe('u-luca')
    expect(defaultOwnerFilter('someone-else', STAFF)).toBe('all')
    expect(defaultOwnerFilter(null, STAFF)).toBe('all')
  })
  it('before the team list has loaded the card shows everyone\'s rather than an empty screen', () => {
    expect(defaultOwnerFilter('u-luca', [])).toBe('all')
  })
})

describe('the per-person filter', () => {
  const T = [
    { id: 1, waiting_us_since: '2026-11-20T10:00:00Z', waiting_us_owner: 'u-antonio' },
    { id: 2, waiting_us_since: '2026-11-22T10:00:00Z', waiting_us_owner: 'u-luca' },
    { id: 3, waiting_us_since: '2026-11-18T10:00:00Z', waiting_us_owner: null },
    { id: 4, waiting_us_since: '2026-11-24T10:00:00Z', waiting_us_owner: 'u-antonio' },
    { id: 5, waiting_us_since: null, waiting_us_owner: 'u-antonio' }, // not waiting on us any more (the mark ended): never listed
  ]
  it('Everyone / Not assigned / one person', () => {
    expect(waitingUsForCard(T, 'all').map(t => t.id)).toEqual([3, 1, 2, 4])
    expect(waitingUsForCard(T, 'none').map(t => t.id)).toEqual([3])
    expect(waitingUsForCard(T, 'u-antonio').map(t => t.id)).toEqual([1, 4])
    expect(waitingUsForCard(T, 'u-jodi')).toEqual([])
  })
  it('longest-waiting first (the oldest mark on top)', () => {
    expect(waitingUsForCard(T, 'all')[0].id).toBe(3)
  })
  it('counts match what each pill lists, and a conversation that is not waiting on us is never counted', () => {
    const c = ownerCounts(T)
    expect(c.all).toBe(4)
    expect(c.none).toBe(1)
    expect(c.byOwner['u-antonio']).toBe(2)
    expect(c.byOwner['u-luca']).toBe(1)
    for (const [id, n] of Object.entries(c.byOwner)) expect(waitingUsForCard(T, id).length).toBe(n)
  })
  it('matchesOwnerFilter agrees with the list', () => {
    expect(matchesOwnerFilter(T[2], 'none')).toBe(true)
    expect(matchesOwnerFilter(T[0], 'none')).toBe(false)
    expect(matchesOwnerFilter(T[0], 'u-antonio')).toBe(true)
    expect(matchesOwnerFilter(T[0], 'u-luca')).toBe(false)
  })
})

describe('who a new mark belongs to', () => {
  const base = { markerId: 'u-antonio', staffIds: STAFF_IDS }
  it('not asked for = the person marking it (the menu\'s default)', () => {
    expect(decideOwnerForMark({ ...base, kind: 'us', requested: undefined })).toEqual({ ok: true, owner: 'u-antonio' })
  })
  it('a marker who is not on the team list is not made the owner', () => {
    expect(decideOwnerForMark({ ...base, markerId: 'a-marketing-login', kind: 'us', requested: undefined })).toEqual({ ok: true, owner: null })
  })
  it('asking for nobody (null or empty) = not assigned', () => {
    expect(decideOwnerForMark({ ...base, kind: 'us', requested: null })).toEqual({ ok: true, owner: null })
    expect(decideOwnerForMark({ ...base, kind: 'us', requested: '' })).toEqual({ ok: true, owner: null })
  })
  it('asking for another team member gives it to them', () => {
    expect(decideOwnerForMark({ ...base, kind: 'us', requested: 'u-jodi' })).toEqual({ ok: true, owner: 'u-jodi' })
  })
  it('refuses anyone who is not on the team list (a client or partner id can never become an owner)', () => {
    const d = decideOwnerForMark({ ...base, kind: 'us', requested: 'a-client-user-id' })
    expect(d.ok).toBe(false)
    expect(d.error).toMatch(/not on the team list/)
  })
  it('"Waiting for client" follows exactly the same rules (it used to never have an owner)', () => {
    expect(decideOwnerForMark({ ...base, kind: 'client', requested: undefined })).toEqual({ ok: true, owner: 'u-antonio' })
    expect(decideOwnerForMark({ ...base, kind: 'client', requested: 'u-jodi' })).toEqual({ ok: true, owner: 'u-jodi' })
    expect(decideOwnerForMark({ ...base, kind: 'client', requested: null })).toEqual({ ok: true, owner: null })
    expect(decideOwnerForMark({ ...base, markerId: 'a-marketing-login', kind: 'client', requested: undefined })).toEqual({ ok: true, owner: null })
    const bad = decideOwnerForMark({ ...base, kind: 'client', requested: 'a-client-user-id' })
    expect(bad.ok).toBe(false)
    expect(bad.error).toMatch(/not on the team list/)
  })
})

describe('"Waiting for client" owners (the second card)', () => {
  const T = [
    { id: 1, waiting_since: '2026-11-20T10:00:00Z', waiting_owner: 'u-antonio' },
    { id: 2, waiting_since: '2026-11-22T10:00:00Z', waiting_owner: 'u-luca' },
    { id: 3, waiting_since: '2026-11-18T10:00:00Z', waiting_owner: null },
    // marked "waiting on us" with an owner: it must never leak into the Waiting-for-client card
    { id: 4, waiting_us_since: '2026-11-19T10:00:00Z', waiting_us_owner: 'u-antonio' },
    // not waiting for the client any more (the mark ended): never listed, even though it still names an owner
    { id: 5, waiting_since: null, waiting_owner: 'u-antonio' },
  ]
  it('reads the right mark and owner for each kind', () => {
    expect(waitingSinceOf(T[0], 'client')).toBe('2026-11-20T10:00:00Z')
    expect(waitingSinceOf(T[0], 'us')).toBeNull()
    expect(waitingSinceOf(T[3], 'us')).toBe('2026-11-19T10:00:00Z')
    expect(waitingOwnerOf(T[0], 'client')).toBe('u-antonio')
    expect(waitingOwnerOf(T[0], 'us')).toBeNull()
    expect(waitingOwnerOf(T[3], 'us')).toBe('u-antonio')
    expect(waitingOwnerOf({}, 'client')).toBeNull()
  })
  it('Everyone / Not assigned / one person, longest first, only conversations waiting for the client', () => {
    expect(waitingForCard(T, 'all', 'client').map(t => t.id)).toEqual([3, 1, 2])
    expect(waitingForCard(T, 'none', 'client').map(t => t.id)).toEqual([3])
    expect(waitingForCard(T, 'u-antonio', 'client').map(t => t.id)).toEqual([1])
    expect(waitingForCard(T, 'u-jodi', 'client')).toEqual([])
  })
  it('counts match what each pill lists, and a conversation waiting on us is never counted here', () => {
    const c = ownerCounts(T, 'client')
    expect(c.all).toBe(3)
    expect(c.none).toBe(1)
    expect(c.byOwner).toEqual({ 'u-antonio': 1, 'u-luca': 1 })
    for (const [id, n] of Object.entries(c.byOwner)) expect(waitingForCard(T, id, 'client').length).toBe(n)
  })
  it('the "Waiting on us" card is unchanged by the new kind: it does not list the client-kind marks, and kind "us" is the default', () => {
    expect(waitingUsForCard(T, 'all').map(t => t.id)).toEqual([4])
    expect(ownerCounts(T).all).toBe(1)
    expect(matchesOwnerFilter(T[3], 'u-antonio')).toBe(true)
    expect(matchesOwnerFilter(T[0], 'u-antonio')).toBe(false)
    expect(matchesOwnerFilter(T[0], 'u-antonio', 'client')).toBe(true)
  })
})

describe('the QA Staff login is not an owner (Antonio, 2026-11-25: "remove QA staff")', () => {
  const MEMBERS = [
    { id: 'u-antonio', email: 'antonio.durante@tonydurante.us' },
    { id: 'u-qa', email: 'qa-staff@tonydurante.us' },
    { id: 'u-support', email: 'support@tonydurante.us' },
    { id: 'u-nomail', email: null },
  ]
  it('the QA Staff login is left out, whatever the capital letters or spaces; everyone else stays, including Support and a login with no email', () => {
    expect(ownerPickerMembers(MEMBERS).map(m => m.id)).toEqual(['u-antonio', 'u-support', 'u-nomail'])
    expect(ownerPickerMembers([{ id: 'x', email: ' QA-Staff@TonyDurante.us ' }])).toEqual([])
  })
  it('the hidden list holds only that one login', () => {
    expect(OWNER_PICKER_HIDDEN_EMAILS).toEqual(['qa-staff@tonydurante.us'])
  })
  it('a hidden login can never be chosen as an owner, and the default owner is never the QA login itself', () => {
    const ids = ownerPickerMembers(MEMBERS).map(m => m.id)
    const d = decideOwnerForMark({ kind: 'us', requested: 'u-qa', markerId: 'u-antonio', staffIds: ids })
    expect(d.ok).toBe(false)
    expect(d.error).toMatch(/not on the team list/)
    expect(decideOwnerForMark({ kind: 'us', requested: undefined, markerId: 'u-qa', staffIds: ids })).toEqual({ ok: true, owner: null })
  })
  it('the picker route AND both routes that check an owner use the same filtered list', () => {
    for (const p of ['app/api/portal/chat/waiting-staff/route.ts', 'app/api/portal/chat/waiting-owner/route.ts', 'app/api/portal/chat/waiting-thread/route.ts']) {
      expect(read(p)).toContain('ownerPickerMembers(await listTeamMembers())')
    }
  })
})

describe('wiring', () => {
  const page = read('app/(dashboard)/portal-chats/page.tsx')
  const markRoute = read('app/api/portal/chat/waiting-thread/route.ts')
  const ownerRoute = read('app/api/portal/chat/waiting-owner/route.ts')
  const threadsRoute = read('app/api/portal/chat/threads/route.ts')
  it('the first chip says who we wait for', () => {
    expect(LIST_FILTER_CHIPS.find(([k]) => k === 'waiting')?.[1]).toBe('Waiting for client')
    expect(LIST_FILTER_CHIPS.find(([k]) => k === 'waitingus')?.[1]).toBe('Waiting on us')
  })
  it('only the two waiting chips open a card (each its own); every other chip closes it', () => {
    expect(page).toContain("setWaitingCardKind(key === 'waiting' ? 'client' : key === 'waitingus' ? 'us' : null)")
    expect(page).toContain("<WaitingOwnersCard")
    expect(page).toContain("{waitingCardKind && listFilter === (waitingCardKind === 'us' ? 'waitingus' : 'waiting') && (")
    expect(page).toContain("key === 'waiting' || key === 'waitingus' ? { 'data-waiting-card-keep': '' }")
  })
  it('the card opens a conversation through the same function the list uses', () => {
    expect(page).toContain('onClick={() => openThread(thread)}')
    expect(page).toContain('openThread(t as ChatThread)')
  })
  it('both menus ask before marking ("Who answers?" / "Who follows up?"), and fall back to a plain click when the team list could not be read', () => {
    expect(page).toContain("'Waiting on us. Who answers?'")
    expect(page).toContain("'Waiting for client. Who follows up?'")
    expect(page).toContain('if (marked || waitingStaff.length === 0) {')
    expect(page).toContain('{markButton(\'client\')}')
    expect(page).toContain('{markButton(\'us\')}')
    expect(page).toContain('waiting: true, kind, assigned_to: s.id')
    expect(page).toContain('waiting: true, kind, assigned_to: null')
  })
  it('an owner is sent for either kind, and the owner route is told which mark it changes', () => {
    expect(page).toContain("...(assigned_to !== undefined ? { assigned_to } : {})")
    expect(page).toContain("body: JSON.stringify({ account_id, contact_id, assigned_to, kind })")
    expect(page).toContain('assigned_to: ownerId, kind: waitingCardKind')
  })
  it('the list row of a "Waiting for client" conversation shows its owner', () => {
    expect(page).toContain('<OwnerBadge staff={waitingStaff} ownerId={thread.waiting_owner} />')
  })
  it('changing the owner uses its own route, which never restarts the clock', () => {
    expect(page).toContain("fetch('/api/portal/chat/waiting-owner'")
    expect(ownerRoute).toContain(".update({ assigned_to: decision.owner }).eq('kind', kind)")
    expect(ownerRoute).not.toContain('marked_at')
  })
  it('an owner screen opened before this change (it sends no kind) still changes a "Waiting on us" mark', () => {
    expect(ownerRoute).toContain("const kind = body.kind === 'client' ? 'client' : 'us'")
  })
  it('the owner is decided BEFORE the old mark is deleted, so a refused owner leaves the existing mark alone', () => {
    expect(markRoute.indexOf('decideOwnerForMark(')).toBeGreaterThan(-1)
    expect(markRoute.indexOf('decideOwnerForMark(')).toBeLessThan(markRoute.indexOf('waits.delete()'))
  })
  it('both server reads and writes keep working before the database column reaches production', () => {
    expect(markRoute).toContain("error?.code === '42703'")
    expect(threadsRoute).toContain("waitRes.error?.code === '42703'")
  })
  it('the thread list returns each conversation\'s owner, for both kinds', () => {
    expect(threadsRoute).toContain('waiting_us_owner:')
    expect(threadsRoute).toContain('waiting_owner:')
    expect(threadsRoute).toContain('if (r.assigned_to) (waitingOnUs ? waitingUsOwner : waitingOwner).set(mapKey, r.assigned_to)')
  })
  it('the mark route decides an owner for any new mark, not only "waiting on us"', () => {
    expect(markRoute).toContain('if (waiting) {')
    expect(markRoute).not.toContain("waiting && kind === 'us'")
  })
})
