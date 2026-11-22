import { describe, it, expect } from 'vitest'
import {
  isPersonalDocumentHiddenFrom,
  isPersonalDocumentHiddenFromViewer,
  mayViewerOpenPersonalDocument,
  sharedPersonalDocInScope,
} from '@/lib/documents/visibility-guard'
import { buildPersonalDocsNotice, PERSONAL_DOCS_NOTICE_VERSION, personalDocsCheckboxLabel } from '@/lib/portal/team/personal-docs-notice'
import { checkNoticeAcceptance } from '@/lib/portal/team/confirm'
import { setPersonalDocShare, type ShareDeps, type ShareMemberRow } from '@/lib/portal/team/personal-docs-share'
import { getSharedPersonalDocOwners, type SharedOwnersDeps } from '@/lib/portal/team/personal-docs-server'
import type { TeamEventInput } from '@/lib/portal/team/events'
import { buildTeamCard } from '@/lib/portal/team/crm-view'
import type { User } from '@supabase/supabase-js'

const OWNER_A = 'contact-a'
const OWNER_B = 'contact-b'
const passport = (owner: string | null, extra: Record<string, unknown> = {}) => ({ category: 2, contact_id: owner, portal_visible: true, ...extra })

// ── the viewing rule ────────────────────────────────────────────────────────
describe('isPersonalDocumentHiddenFromViewer', () => {
  it('a team login sees NO personal document when nothing is shared (and the old rule still hides everything from it)', () => {
    expect(isPersonalDocumentHiddenFromViewer(passport(OWNER_A), { contactId: null, sharedFrom: [] })).toBe(true)
    expect(isPersonalDocumentHiddenFromViewer(passport(OWNER_A), { contactId: null })).toBe(true)
    expect(isPersonalDocumentHiddenFrom(passport(OWNER_A), null)).toBe(true) // every other place keeps this answer
  })

  it('sees an owner\'s personal document only when THAT owner shared', () => {
    expect(isPersonalDocumentHiddenFromViewer(passport(OWNER_A), { contactId: null, sharedFrom: [OWNER_A] })).toBe(false)
    expect(isPersonalDocumentHiddenFromViewer(passport(OWNER_B), { contactId: null, sharedFrom: [OWNER_A] })).toBe(true)
  })

  it('a document with no resolved owner is hidden even if people shared', () => {
    expect(isPersonalDocumentHiddenFromViewer(passport(null), { contactId: null, sharedFrom: [OWNER_A, OWNER_B] })).toBe(true)
  })

  it('a client still sees only their own, and a shared list never exposes a co-owner\'s', () => {
    expect(isPersonalDocumentHiddenFromViewer(passport(OWNER_A), { contactId: OWNER_A })).toBe(false)
    expect(isPersonalDocumentHiddenFromViewer(passport(OWNER_B), { contactId: OWNER_A })).toBe(true)
  })

  it('a document that is not personal is never hidden by this rule', () => {
    expect(isPersonalDocumentHiddenFromViewer({ category: 1, contact_id: null }, { contactId: null })).toBe(false)
  })
})

describe('mayViewerOpenPersonalDocument (the download decision)', () => {
  it('a client: only their own personal document, exactly as before', () => {
    expect(mayViewerOpenPersonalDocument(passport(OWNER_A), { contactId: OWNER_A })).toBe(true)
    expect(mayViewerOpenPersonalDocument(passport(OWNER_B), { contactId: OWNER_A })).toBe(false)
    expect(mayViewerOpenPersonalDocument(passport(null), { contactId: OWNER_A })).toBe(false)
  })

  it('a team login: only through the owner\'s share', () => {
    expect(mayViewerOpenPersonalDocument(passport(OWNER_A), { contactId: null, sharedFrom: [OWNER_A] })).toBe(true)
    expect(mayViewerOpenPersonalDocument(passport(OWNER_A), { contactId: null, sharedFrom: [OWNER_B] })).toBe(false)
    expect(mayViewerOpenPersonalDocument(passport(OWNER_A), { contactId: null, sharedFrom: [] })).toBe(false)
    expect(mayViewerOpenPersonalDocument(passport(OWNER_A), { contactId: null })).toBe(false)
  })

  it('a share never reaches a document staff have not published', () => {
    expect(mayViewerOpenPersonalDocument(passport(OWNER_A, { portal_visible: false }), { contactId: null, sharedFrom: [OWNER_A] })).toBe(false)
    expect(mayViewerOpenPersonalDocument(passport(OWNER_A, { portal_visible: null }), { contactId: null, sharedFrom: [OWNER_A] })).toBe(false)
  })

  it('does not decide for a document that is not personal', () => {
    expect(mayViewerOpenPersonalDocument({ category: 3, contact_id: null, portal_visible: false }, { contactId: null })).toBe(true)
  })
})

describe('sharedPersonalDocInScope (the download route opens only what the page lists)', () => {
  it('this login\'s company, person-level papers and the new storage are in; another company\'s paper is out', () => {
    expect(sharedPersonalDocInScope({ account_id: 'acc-1', drive_file_id: 'drive:x' }, 'acc-1')).toBe(true)
    expect(sharedPersonalDocInScope({ account_id: null, drive_file_id: 'drive:x' }, 'acc-1')).toBe(true)
    expect(sharedPersonalDocInScope({ account_id: 'acc-2', drive_file_id: 'store:abc' }, 'acc-1')).toBe(true)
    expect(sharedPersonalDocInScope({ account_id: 'acc-2', drive_file_id: 'drive:x' }, 'acc-1')).toBe(false)
    expect(sharedPersonalDocInScope({ account_id: 'acc-2', drive_file_id: null }, 'acc-1')).toBe(false)
    expect(sharedPersonalDocInScope({ account_id: 'acc-2', drive_file_id: 'drive:x' }, undefined)).toBe(false)
  })
})

// ── the notice the owner accepts ─────────────────────────────────────────────
describe('buildPersonalDocsNotice', () => {
  it('names what is shared, says only the owner\'s OWN papers, and carries the version', () => {
    const n = buildPersonalDocsNotice({ lang: 'en', memberName: '  Sam ', companyName: ' Acme   LLC ' })
    expect(n.version).toBe(PERSONAL_DOCS_NOTICE_VERSION)
    expect(n.title).toBe('You are about to let Sam see YOUR personal documents.')
    expect(n.text).toMatch(/passport, ID, proof of address and tax numbers/)
    expect(n.text).toMatch(/Acme LLC portal/)
    expect(n.never).toMatch(/Only YOUR documents are shared, never another owner/)
    expect(n.never).toMatch(/switch this off at any time/)
    expect(n.text.endsWith(`[${PERSONAL_DOCS_NOTICE_VERSION}]`)).toBe(true)
  })

  it('exists in Italian too', () => {
    const n = buildPersonalDocsNotice({ lang: 'it', memberName: 'Sam', companyName: 'Acme LLC' })
    expect(n.title).toBe('Stai per permettere a Sam di vedere i TUOI documenti personali.')
    expect(n.never).toMatch(/solo i TUOI documenti/)
    expect(personalDocsCheckboxLabel('it')).toMatch(/documenti personali/)
    expect(personalDocsCheckboxLabel('en')).toMatch(/personal documents/)
  })

  it('never guesses a pronoun', () => {
    for (const lang of ['en', 'it'] as const) {
      expect(buildPersonalDocsNotice({ lang, memberName: 'Alex', companyName: 'X' }).text).not.toMatch(/\b(he|she|his|hers?|lui|lei)\b/i)
    }
  })

  it('works with the existing word-for-word acceptance check (a changed text is refused)', () => {
    const n = buildPersonalDocsNotice({ lang: 'en', memberName: 'Sam', companyName: 'X' })
    expect(checkNoticeAcceptance({ notice_accepted: true, notice_version: n.version, notice_text: n.text }, n, '1.2.3.4')).toMatchObject({ ok: true, confirmation: { version: n.version, text: n.text, ip: '1.2.3.4' } })
    expect(checkNoticeAcceptance({ notice_accepted: true, notice_version: n.version, notice_text: n.text + ' ' }, n, null)).toMatchObject({ ok: false, status: 409 })
    expect(checkNoticeAcceptance({ notice_accepted: false, notice_version: n.version, notice_text: n.text }, n, null)).toMatchObject({ ok: false, status: 400 })
  })
})

// ── switching a share on and off ─────────────────────────────────────────────
const member: ShareMemberRow = { id: 'tm-1', display_name: 'Sam', status: 'active', capabilities: { documents: true } }
const confirmation = { version: PERSONAL_DOCS_NOTICE_VERSION, text: 'the exact words', ip: '203.0.113.9' }

function fakeShareDeps(over: Partial<ShareDeps> & { shares?: Set<string>; member?: ShareMemberRow | null } = {}) {
  const shares = over.shares ?? new Set<string>()
  const events: TeamEventInput[] = []
  const added: unknown[] = []
  const deps: ShareDeps = {
    fetchMember: async () => (over.member === undefined ? member : over.member),
    hasShare: async (tm, owner) => shares.has(`${tm}|${owner}`),
    addShare: async (row) => {
      added.push(row)
      shares.add(`${row.team_member_id}|${row.owner_contact_id}`)
    },
    removeShare: async (tm, owner) => {
      shares.delete(`${tm}|${owner}`)
    },
    recordEvent: async (e) => {
      events.push(e)
    },
    recordEventBestEffort: async (e) => {
      events.push(e)
      return true
    },
    ...over,
  }
  return { deps, shares, events, added }
}

const on = { teamMemberId: 'tm-1', accountId: 'acc-1', ownerContactId: OWNER_A, enabled: true, confirmation, ip: '203.0.113.9' }
const off = { ...on, enabled: false, confirmation: null }

describe('setPersonalDocShare — a failed database read or write is an ERROR, never "nothing changed"', () => {
  it('STOP sharing: when the share list cannot be read the owner is told so (the share may still be there)', async () => {
    const { deps, shares, events } = fakeShareDeps({ shares: new Set(['tm-1|contact-a']), hasShare: async () => { throw new Error('db down') } })
    const r = await setPersonalDocShare(off, deps)
    expect(r).toMatchObject({ ok: false, status: 500 })
    expect((r as { error: string }).error).toMatch(/nothing was changed/)
    expect(shares.has('tm-1|contact-a')).toBe(true) // untouched
    expect(events).toEqual([])
  })
  it('STOP sharing: when the person cannot be read it is an error, not "team member not found"', async () => {
    const { deps } = fakeShareDeps({ fetchMember: async () => { throw new Error('db down') } })
    expect(await setPersonalDocShare(off, deps)).toMatchObject({ ok: false, status: 500 })
  })
  it('STOP sharing: when the delete itself fails the owner is told the person may still see the documents', async () => {
    const { deps, shares, events } = fakeShareDeps({ shares: new Set(['tm-1|contact-a']), removeShare: async () => { throw new Error('db down') } })
    const r = await setPersonalDocShare(off, deps)
    expect(r).toMatchObject({ ok: false, status: 500 })
    expect((r as { error: string }).error).toMatch(/may still see/)
    expect(shares.has('tm-1|contact-a')).toBe(true)
    expect(events).toEqual([]) // no "stopped sharing" line for something that did not stop
  })
  it('SWITCHING ON with an unreadable share list saves nothing', async () => {
    const { deps, added } = fakeShareDeps({ hasShare: async () => { throw new Error('db down') } })
    expect(await setPersonalDocShare(on, deps)).toMatchObject({ ok: false, status: 500 })
    expect(added).toEqual([])
  })
  it('a share that is really not there is still "nothing to stop" (the honest no-op)', async () => {
    const { deps } = fakeShareDeps()
    expect(await setPersonalDocShare(off, deps)).toEqual({ ok: true, changed: false })
  })
})

describe('setPersonalDocShare — switching ON', () => {
  it('saves the share and records the exact words, naming the owner who acted', async () => {
    const { deps, shares, events, added } = fakeShareDeps()
    expect(await setPersonalDocShare(on, deps)).toEqual({ ok: true, changed: true })
    expect(shares.has('tm-1|contact-a')).toBe(true)
    expect(added).toEqual([{ team_member_id: 'tm-1', owner_contact_id: OWNER_A, account_id: 'acc-1', notice_version: PERSONAL_DOCS_NOTICE_VERSION, granted_ip: '203.0.113.9' }])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ event: 'powers_changed', actor: { kind: 'owner', contactId: OWNER_A }, detail: { personal_documents: true, owner_contact_id: OWNER_A, personal_docs_notice_version: PERSONAL_DOCS_NOTICE_VERSION, personal_docs_notice_text: 'the exact words' } })
    expect(events[0].detail).not.toHaveProperty('notice_text') // never the staff card's "notice accepted" keys
  })

  it('needs the owner\'s confirmation: without it nothing is saved and the screen is asked to confirm', async () => {
    const { deps, shares, events } = fakeShareDeps()
    const r = await setPersonalDocShare({ ...on, confirmation: null }, deps)
    expect(r).toMatchObject({ ok: false, status: 409, needsConfirmation: true })
    expect(shares.size).toBe(0)
    expect(events).toEqual([])
  })

  it('needs the Documents tick (without it the person cannot open the Documents page)', async () => {
    const { deps, shares } = fakeShareDeps({ member: { ...member, capabilities: { chat: true } } })
    expect(await setPersonalDocShare(on, deps)).toMatchObject({ ok: false, status: 400 })
    expect(shares.size).toBe(0)
  })

  it('refuses a switched-off login, and a login that is not in this company', async () => {
    expect(await setPersonalDocShare(on, fakeShareDeps({ member: { ...member, status: 'revoked' } }).deps)).toMatchObject({ ok: false, status: 400 })
    expect(await setPersonalDocShare(on, fakeShareDeps({ member: null }).deps)).toMatchObject({ ok: false, status: 404 })
  })

  it('doing it twice changes nothing the second time (no second line in the record)', async () => {
    const { deps, events } = fakeShareDeps({ shares: new Set(['tm-1|contact-a']) })
    expect(await setPersonalDocShare(on, deps)).toEqual({ ok: true, changed: false })
    expect(events).toEqual([])
  })

  it('no record, no grant: if the record line cannot be saved the share is undone', async () => {
    const { deps, shares } = fakeShareDeps({
      recordEvent: async () => {
        throw new Error('db down')
      },
    })
    expect(await setPersonalDocShare(on, deps)).toMatchObject({ ok: false, status: 500 })
    expect(shares.size).toBe(0)
  })

  it('one owner\'s share never creates another owner\'s: each is its own row', async () => {
    const { deps, shares } = fakeShareDeps()
    await setPersonalDocShare(on, deps)
    await setPersonalDocShare({ ...on, ownerContactId: OWNER_B }, deps)
    expect(Array.from(shares).sort()).toEqual(['tm-1|contact-a', 'tm-1|contact-b'])
    await setPersonalDocShare({ ...off, ownerContactId: OWNER_B }, deps)
    expect(Array.from(shares)).toEqual(['tm-1|contact-a']) // B stopped; A's is untouched
  })
})

describe('setPersonalDocShare — switching OFF', () => {
  it('removes the share at once and records it', async () => {
    const { deps, shares, events } = fakeShareDeps({ shares: new Set(['tm-1|contact-a']) })
    expect(await setPersonalDocShare(off, deps)).toEqual({ ok: true, changed: true })
    expect(shares.size).toBe(0)
    expect(events[0]).toMatchObject({ event: 'powers_changed', detail: { personal_documents: false, owner_contact_id: OWNER_A } })
  })

  it('is never blocked: works for a switched-off login, and a failing record line never stops it', async () => {
    const { deps, shares } = fakeShareDeps({
      shares: new Set(['tm-1|contact-a']),
      member: { ...member, status: 'revoked', capabilities: {} },
      recordEventBestEffort: async () => false,
    })
    expect(await setPersonalDocShare(off, deps)).toEqual({ ok: true, changed: true })
    expect(shares.size).toBe(0)
  })

  it('switching off what was never shared changes nothing', async () => {
    const { deps, events } = fakeShareDeps()
    expect(await setPersonalDocShare(off, deps)).toEqual({ ok: true, changed: false })
    expect(events).toEqual([])
  })
})

// ── who a signed-in person may see personal documents from ───────────────────
function sharedDeps(over: Partial<SharedOwnersDeps> & { caps?: Record<string, boolean>; kind?: 'teammate' | 'contact' | 'none' } = {}): SharedOwnersDeps {
  return {
    resolveIdentity: async () =>
      over.kind === 'contact'
        ? { kind: 'contact', contactId: 'c1', accountIds: ['acc-1'] }
        : over.kind === 'none'
          ? { kind: 'none' }
          : { kind: 'teammate', teamMemberId: 'tm-1', accountId: 'acc-1', displayName: 'Sam', email: null, capabilities: over.caps ?? { documents: true } },
    fetchShares: async () => [OWNER_A, OWNER_B],
    stillOwner: async () => true,
    names: async (ids) => new Map(ids.map((i) => [i, i === OWNER_A ? 'Ann Owner' : 'Bob Owner'])),
    ...over,
  }
}
const user = { id: 'auth-1', app_metadata: { kind: 'team_member' } } as unknown as User

describe('getSharedPersonalDocOwners', () => {
  it('returns the owners who shared, with their names', async () => {
    expect(await getSharedPersonalDocOwners(user, sharedDeps())).toEqual([
      { contactId: OWNER_A, name: 'Ann Owner', accountId: 'acc-1' },
      { contactId: OWNER_B, name: 'Bob Owner', accountId: 'acc-1' },
    ])
  })

  it('nothing for a client, an unknown login, a signed-out visitor', async () => {
    expect(await getSharedPersonalDocOwners(user, sharedDeps({ kind: 'contact' }))).toEqual([])
    expect(await getSharedPersonalDocOwners(user, sharedDeps({ kind: 'none' }))).toEqual([])
    expect(await getSharedPersonalDocOwners(null, sharedDeps())).toEqual([])
  })

  it('nothing without the Documents tick — including a login still waiting for its notice, whose powers are held back', async () => {
    expect(await getSharedPersonalDocOwners(user, sharedDeps({ caps: { chat: true } }))).toEqual([])
    expect(await getSharedPersonalDocOwners(user, sharedDeps({ caps: {} }))).toEqual([])
  })

  it('ignores an owner who is no longer an owner or member of the company', async () => {
    const r = await getSharedPersonalDocOwners(user, sharedDeps({ stillOwner: async (id) => id === OWNER_A }))
    expect(r.map((o) => o.contactId)).toEqual([OWNER_A])
  })

  it('any failure means "nothing shared" — it never throws and never opens anything', async () => {
    const r = await getSharedPersonalDocOwners(user, sharedDeps({ fetchShares: async () => { throw new Error('table missing') } }))
    expect(r).toEqual([])
  })
})

// ── the staff Team card ───────────────────────────────────────────────────────
describe('the staff Team card and the personal-documents lines', () => {
  const m = { id: 'tm-1', username: 'sam', display_name: 'Sam', capabilities: { documents: true }, status: 'active', created_at: '2026-11-01T00:00:00Z', auth_user_id: null }
  const ev = (event: string, at: string, detail: Record<string, unknown>, actor_contact_id: string | null = OWNER_A) => ({
    team_member_id: 'tm-1', account_id: 'acc-1', event, actor_kind: 'owner', actor_contact_id, actor_staff_email: null, detail, ip: null, created_at: at,
  })

  it('says in words that an owner shared, or stopped sharing, their personal documents — and who', () => {
    const card = buildTeamCard({
      members: [m] as never,
      events: [
        ev('added', '2026-11-01T00:00:00Z', { notice_version: 'v1-draft', notice_text: 'POWERS NOTICE' }),
        ev('powers_changed', '2026-11-02T00:00:00Z', { personal_documents: true, personal_docs_notice_text: 'PERSONAL NOTICE' }),
        ev('powers_changed', '2026-11-03T00:00:00Z', { personal_documents: false }),
      ] as never,
      names: { [OWNER_A]: 'Ann Owner' },
      signIns: {},
    })[0]
    expect(card.history.map((h) => h.label)).toEqual(['Stopped sharing their personal documents', 'Shared their personal documents', 'Added'])
    expect(card.history[0].by).toBe('Ann Owner')
  })

  it('a personal-documents line never replaces the notice accepted when the person was added', () => {
    const card = buildTeamCard({
      members: [m] as never,
      events: [
        ev('added', '2026-11-01T00:00:00Z', { notice_version: 'v1-draft', notice_text: 'POWERS NOTICE' }),
        ev('powers_changed', '2026-11-02T00:00:00Z', { personal_documents: true, personal_docs_notice_version: 'v1-draft-personal-docs', personal_docs_notice_text: 'PERSONAL NOTICE' }),
      ] as never,
      names: {},
      signIns: {},
    })[0]
    expect(card.notice?.text).toBe('POWERS NOTICE')
  })

  it('an ordinary powers change keeps its old label', () => {
    const card = buildTeamCard({ members: [m] as never, events: [ev('powers_changed', '2026-11-02T00:00:00Z', {})] as never, names: {}, signIns: {} })[0]
    expect(card.history[0].label).toBe('Powers changed')
  })
})
