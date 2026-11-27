// Portal Chats — the five fixes after the Bug-Hunter review of the staff-name + reply-target work (dev jobs 8d077f3b / cb02b03d, 2026-11-26).
// These test BEHAVIOUR (real inputs, real outputs), not source text.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { audienceHeadCount, shouldShowAudienceNotice } from '@/lib/portal-chats/audience-count'
import {
  AUTOMATION_SENDER_IDS,
  isAutomationSenderId,
  newStaffLabelCache,
  resolveStaffLabels,
  senderIdsToName,
  staffRowSenderName,
  type StaffLookup,
} from '@/lib/portal/staff-display-name'
import { replyTargetIsFrozen, savedDraftKeepsPersonal } from '@/lib/portal-chats/default-reply-company'
import { mergeLiveUpdate } from '@/lib/portal-chats/merge-live-update'
import { COMPOSER_APP_FLOOR_PX, COMPOSER_MAX_PX, composerMaxHeight, usableVisibleHeight } from '@/lib/portal-chats/composer-height'

const ANTONIO_LOGIN = 'b0da5d9c-acf6-4761-9cae-2c3b14dbc631'
const LUCA = '630035c6-09ae-4462-be2d-4b76fed984ad'
const JODI = '2c2b250b-b0af-4eb2-ae21-b14d08647efb'

describe('fix 1 — the "who sees this" notice counts the real roster, not only the linked contacts', () => {
  it('a company with 2 members on the roster but 1 linked contact counts 2 members (the thin-mirror case)', () => {
    expect(audienceHeadCount({ contact_count: 1, member_count: 2, chat_teammate_count: 0 })).toEqual({ members: 2, teammates: 0, total: 2 })
  })

  it('takes the LARGER of linked contacts and roster, never the sum', () => {
    expect(audienceHeadCount({ contact_count: 3, member_count: 2, chat_teammate_count: 0 }).members).toBe(3)
    expect(audienceHeadCount({ contact_count: 2, member_count: 2, chat_teammate_count: 0 }).members).toBe(2)
  })

  it('portal teammates are added on top', () => {
    expect(audienceHeadCount({ contact_count: 1, member_count: 1, chat_teammate_count: 2 })).toEqual({ members: 1, teammates: 2, total: 3 })
  })

  it('a missing, null, negative or odd count is 0, so an old server answer without member_count still works', () => {
    expect(audienceHeadCount(undefined)).toEqual({ members: 0, teammates: 0, total: 0 })
    expect(audienceHeadCount({ contact_count: 2, chat_teammate_count: 0 }).members).toBe(2)
    expect(audienceHeadCount({ contact_count: -4, member_count: Number.NaN, chat_teammate_count: null }).total).toBe(0)
  })

  it('a person\'s reply that defaults to a thin-mirror company now shows the warning (it showed nothing before)', () => {
    const heads = audienceHeadCount({ contact_count: 1, member_count: 2, chat_teammate_count: 0 })
    // in a person's chat the thread's own member list and the "Addressed to" roster are empty, so only the head-count can trigger the notice
    expect(shouldShowAudienceNotice({ closed: false, hasTarget: true, total: heads.total, threadMembers: 0, addressedToOptions: 0 })).toBe(true)
    const before = audienceHeadCount({ contact_count: 1, chat_teammate_count: 0 })
    expect(shouldShowAudienceNotice({ closed: false, hasTarget: true, total: before.total, threadMembers: 0, addressedToOptions: 0 })).toBe(false)
  })

  it('no warning for Personal (no target), for a closed company, or for a company with exactly one person', () => {
    expect(shouldShowAudienceNotice({ closed: false, hasTarget: false, total: 5, threadMembers: 5, addressedToOptions: 5 })).toBe(false)
    expect(shouldShowAudienceNotice({ closed: true, hasTarget: true, total: 5, threadMembers: 0, addressedToOptions: 0 })).toBe(false)
    expect(shouldShowAudienceNotice({ closed: false, hasTarget: true, total: 1, threadMembers: 1, addressedToOptions: 1 })).toBe(false)
  })

  it('the other two triggers still work on their own', () => {
    expect(shouldShowAudienceNotice({ closed: false, hasTarget: true, total: 1, threadMembers: 2, addressedToOptions: 0 })).toBe(true)
    expect(shouldShowAudienceNotice({ closed: false, hasTarget: true, total: 1, threadMembers: 0, addressedToOptions: 3 })).toBe(true)
  })
})

describe('fix 2 — a name only on messages a person typed; automatic messages stay "TD Team"', () => {
  it('the shared system sender id is recognised (any letter case) and a real login is not', () => {
    expect(AUTOMATION_SENDER_IDS).toContain(ANTONIO_LOGIN)
    expect(isAutomationSenderId(ANTONIO_LOGIN)).toBe(true)
    expect(isAutomationSenderId(ANTONIO_LOGIN.toUpperCase())).toBe(true)
    expect(isAutomationSenderId(LUCA)).toBe(false)
    expect(isAutomationSenderId(null)).toBe(false)
    expect(isAutomationSenderId('')).toBe(false)
  })

  it('only staff rows with no stored name and a real login are looked up', () => {
    const rows = [
      { sender_type: 'admin', sender_id: ANTONIO_LOGIN, sender_name: null }, // automatic
      { sender_type: 'admin', sender_id: LUCA, sender_name: null },
      { sender_type: 'admin', sender_id: LUCA, sender_name: '' },
      { sender_type: 'admin', sender_id: JODI, sender_name: '  ' },
      { sender_type: 'admin', sender_id: 'ffffffff-0000-0000-0000-000000000001', sender_name: 'Antonio' }, // already named
      { sender_type: 'client', sender_id: 'c1', sender_name: null },
      { sender_type: 'system', sender_id: 's1', sender_name: null },
      { sender_type: 'admin', sender_id: null, sender_name: null },
    ]
    expect(senderIdsToName(rows).sort()).toEqual([JODI, LUCA].sort())
  })

  it('an old automatic row (the system sender id) stays "TD Team" even if a name was somehow found for that id', () => {
    const resolved = new Map<string, string | null>([[ANTONIO_LOGIN, 'Antonio'], [LUCA, 'Luca']])
    expect(staffRowSenderName({ sender_id: ANTONIO_LOGIN, sender_name: null }, resolved)).toBeNull()
  })

  it('an old row from Luca\'s or Jodi\'s own login gets their name', () => {
    const resolved = new Map<string, string | null>([[LUCA, 'Luca'], [JODI, 'Jodi']])
    expect(staffRowSenderName({ sender_id: LUCA, sender_name: null }, resolved)).toBe('Luca')
    expect(staffRowSenderName({ sender_id: JODI, sender_name: '' }, resolved)).toBe('Jodi')
  })

  it('a message Antonio TYPED keeps the name stored on it, even though it carries the system sender id', () => {
    expect(staffRowSenderName({ sender_id: ANTONIO_LOGIN, sender_name: 'Antonio' }, new Map())).toBe('Antonio')
  })

  it('a shared login, an unknown sender or a failed lookup is "TD Team"', () => {
    const resolved = new Map<string, string | null>([['support-id', null]])
    expect(staffRowSenderName({ sender_id: 'support-id', sender_name: null }, resolved)).toBeNull()
    expect(staffRowSenderName({ sender_id: 'nobody', sender_name: null }, resolved)).toBeNull()
    expect(staffRowSenderName({ sender_id: null, sender_name: null }, resolved)).toBeNull()
  })
})

describe('fix 3 — a slow login lookup never holds the chat open', () => {
  const user = (full_name: string, email: string) => ({ email, user_metadata: { full_name } })

  it('gives up after the time limit, answers "TD Team" (null) and does NOT remember the failure', async () => {
    const never: StaffLookup = () => new Promise(() => { /* never answers */ })
    const cache = newStaffLabelCache()
    const started = Date.now()
    const out = await resolveStaffLabels([LUCA], never, cache, Date.now(), 30)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(out.get(LUCA)).toBeNull()
    expect(cache.map.size).toBe(0)
    // next read, the service is back: the name appears
    const working: StaffLookup = async () => user('Luca Degasper', 'luca@tonydurante.us')
    const again = await resolveStaffLabels([LUCA], working, cache, Date.now(), 30)
    expect(again.get(LUCA)).toBe('Luca')
  })

  it('a lookup that answers in time is used and remembered', async () => {
    const quick: StaffLookup = async () => { await new Promise(r => setTimeout(r, 5)); return user('Jodi', 'jodi@tonydurante.us') }
    const cache = newStaffLabelCache()
    const out = await resolveStaffLabels([JODI], quick, cache, Date.now(), 500)
    expect(out.get(JODI)).toBe('Jodi')
    expect(cache.map.get(JODI)?.label).toBe('Jodi')
  })

  it('one slow sender does not delay or spoil the others', async () => {
    const lookup: StaffLookup = (id) => (id === LUCA ? new Promise(() => {}) : Promise.resolve(user('Jodi', 'jodi@tonydurante.us')))
    const out = await resolveStaffLabels([LUCA, JODI], lookup, newStaffLabelCache(), Date.now(), 30)
    expect(out.get(LUCA)).toBeNull()
    expect(out.get(JODI)).toBe('Jodi')
  })
})

describe('fix 4 — the reply target stays put while a reply is in progress', () => {
  const idle = { replyText: '', stagedFileCount: 0, recording: false, sendPopupOpen: false }

  it('free to follow the client when nothing is in progress (blank or spaces only counts as nothing)', () => {
    expect(replyTargetIsFrozen(idle)).toBe(false)
    expect(replyTargetIsFrozen({ ...idle, replyText: '   \n ' })).toBe(false)
  })

  it('frozen by typed words, a staged file or voice note, a recording, or the open pop-up — each on its own', () => {
    expect(replyTargetIsFrozen({ ...idle, replyText: 'Hi' })).toBe(true)
    expect(replyTargetIsFrozen({ ...idle, stagedFileCount: 1 })).toBe(true)
    expect(replyTargetIsFrozen({ ...idle, recording: true })).toBe(true)
    expect(replyTargetIsFrozen({ ...idle, sendPopupOpen: true })).toBe(true)
  })

  it('a conversation reopened with an unsent draft keeps Personal; an empty or missing draft does not', () => {
    expect(savedDraftKeepsPersonal({ replyText: 'half a sentence', pendingAdminFiles: [] })).toBe(true)
    expect(savedDraftKeepsPersonal({ replyText: '', pendingAdminFiles: [{}] })).toBe(true)
    expect(savedDraftKeepsPersonal({ replyText: '  ', pendingAdminFiles: [] })).toBe(false)
    expect(savedDraftKeepsPersonal({ replyText: null, pendingAdminFiles: null })).toBe(false)
    expect(savedDraftKeepsPersonal(null)).toBe(false)
    expect(savedDraftKeepsPersonal(undefined)).toBe(false)
  })
})

describe('fix 5 — a live change never wipes the name on screen, and a zero height reading never squeezes the box', () => {
  const shown = { id: 'm1', message: 'Hi', read_at: null as string | null, sender_name: 'Luca' as string | null }

  it('marking a message read (the update has no stored name) keeps the shown name', () => {
    const merged = mergeLiveUpdate(shown, { id: 'm1', message: 'Hi', read_at: '2026-11-26T10:00:00Z', sender_name: null })
    expect(merged.read_at).toBe('2026-11-26T10:00:00Z')
    expect(merged.sender_name).toBe('Luca')
  })

  it('an empty or blank name in the update is treated the same as none', () => {
    expect(mergeLiveUpdate(shown, { ...shown, sender_name: '' }).sender_name).toBe('Luca')
    expect(mergeLiveUpdate(shown, { ...shown, sender_name: '   ' }).sender_name).toBe('Luca')
  })

  it('a real name in the update still wins, and other fields always update', () => {
    const merged = mergeLiveUpdate(shown, { ...shown, message: 'Hi (edited)', sender_name: 'Jodi' })
    expect(merged.sender_name).toBe('Jodi')
    expect(merged.message).toBe('Hi (edited)')
  })

  it('nothing shown and nothing in the update stays nothing', () => {
    expect(mergeLiveUpdate({ ...shown, sender_name: null }, { ...shown, sender_name: null }).sender_name).toBeNull()
  })

  it('a height reading of 0, a negative, NaN or a non-number is ignored; a real one is rounded to 10 px', () => {
    expect(usableVisibleHeight(0)).toBeNull()
    expect(usableVisibleHeight(-5)).toBeNull()
    expect(usableVisibleHeight(Number.NaN)).toBeNull()
    expect(usableVisibleHeight(undefined)).toBeNull()
    expect(usableVisibleHeight('340')).toBeNull()
    expect(usableVisibleHeight(337.4)).toBe(340)
  })

  it('with no usable reading the app box keeps its normal cap instead of shrinking to the floor', () => {
    expect(composerMaxHeight(usableVisibleHeight(0), true)).toBe(COMPOSER_MAX_PX)
    expect(composerMaxHeight(usableVisibleHeight(340), true)).toBeLessThan(COMPOSER_MAX_PX)
    expect(composerMaxHeight(usableVisibleHeight(340), true)).toBeGreaterThanOrEqual(COMPOSER_APP_FLOOR_PX)
  })
})

describe('the fixes are connected where they matter', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

  it('the audience answer carries the real roster count, and both screens use the larger-of rule', () => {
    expect(read('app/api/portal/chat/audience/route.ts')).toContain('member_count: memberCount')
    const page = read('app/(dashboard)/portal-chats/page.tsx')
    expect(page).toContain('const audienceHeads = audienceHeadCount(sendAudience)')
    expect(page).not.toContain('sendAudience?.contact_count')
  })

  it('both live-update sites (staff screen and client portal) merge through mergeLiveUpdate, never a plain spread', () => {
    for (const f of ['app/(dashboard)/portal-chats/page.tsx', 'lib/hooks/use-portal-chat.ts']) {
      const src = read(f)
      expect(src).toContain('mergeLiveUpdate(m, updated)')
      expect(src).not.toContain('{ ...m, ...updated }')
    }
  })

  it('the old-message lookup is bounded by the timeout and skips the automation sender', () => {
    const route = read('app/api/portal/chat/route.ts')
    expect(route).toContain('senderIdsToName(')
    expect(read('lib/portal/staff-display-name.ts')).toContain('STAFF_LOOKUP_TIMEOUT_MS')
  })
})
