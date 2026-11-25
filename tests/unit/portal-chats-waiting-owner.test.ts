/**
 * "Waiting on us" owners (Antonio, 2026-11-25, dev job 40b5fd59): every conversation the client is waiting on us for belongs to one team member (or
 * nobody yet); the card under the chip lists them with a filter per person and opens on the viewer's own.
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
  it('"Waiting for client" never has an owner, whatever was sent', () => {
    expect(decideOwnerForMark({ ...base, kind: 'client', requested: 'u-jodi' })).toEqual({ ok: true, owner: null })
    expect(decideOwnerForMark({ ...base, kind: 'client', requested: undefined })).toEqual({ ok: true, owner: null })
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
  it('only the "Waiting on us" chip opens the card; every other chip closes it', () => {
    expect(page).toContain("setWaitingCardOpen(key === 'waitingus')")
    expect(page).toContain("<WaitingOnUsCard")
    expect(page).toContain("{waitingCardOpen && listFilter === 'waitingus' && (")
  })
  it('the card opens a conversation through the same function the list uses', () => {
    expect(page).toContain('onClick={() => openThread(thread)}')
    expect(page).toContain('openThread(t as ChatThread)')
  })
  it('the "Who answers?" menu asks before marking, and falls back to a plain click when the team list could not be read', () => {
    expect(page).toContain('Waiting on us. Who answers?')
    expect(page).toContain('waitingUs || waitingStaff.length === 0 ? (')
    expect(page).toContain("kind: 'us', assigned_to: s.id")
    expect(page).toContain("kind: 'us', assigned_to: null")
  })
  it('changing the owner uses its own route, which never restarts the clock', () => {
    expect(page).toContain("fetch('/api/portal/chat/waiting-owner'")
    expect(ownerRoute).toContain(".update({ assigned_to: decision.owner }).eq('kind', 'us')")
    expect(ownerRoute).not.toContain('marked_at')
  })
  it('the owner is decided BEFORE the old mark is deleted, so a refused owner leaves the existing mark alone', () => {
    expect(markRoute.indexOf('decideOwnerForMark(')).toBeGreaterThan(-1)
    expect(markRoute.indexOf('decideOwnerForMark(')).toBeLessThan(markRoute.indexOf('waits.delete()'))
  })
  it('both server reads and writes keep working before the database column reaches production', () => {
    expect(markRoute).toContain("error?.code === '42703'")
    expect(threadsRoute).toContain("waitRes.error?.code === '42703'")
  })
  it('the thread list returns each conversation\'s owner', () => {
    expect(threadsRoute).toContain('waiting_us_owner:')
    expect(threadsRoute).toContain('if (waitingOnUs && r.assigned_to) waitingUsOwner.set(mapKey, r.assigned_to)')
  })
})
