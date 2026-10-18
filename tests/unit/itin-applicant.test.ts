import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock('@/lib/crm-store/formation-pilot', () => ({ raisePilotAlarm: vi.fn(), ensurePersonOwner: vi.fn() }))
vi.mock('@/lib/crm-store/switched-drive-guard', () => ({}))

import { resolveItinApplicant, type ItinApplicantDeps, type ItinContact } from '@/lib/crm-store/itin-applicant'

const ann: ItinContact = { id: 'c-ann', full_name: 'Ann Lee', email: 'ann@x.com' }
const bob: ItinContact = { id: 'c-bob', full_name: 'Bob Roe', email: 'bob@x.com' }
const deps = (linked: ItinContact[], all: ItinContact[] = linked): ItinApplicantDeps => ({
  linkedContacts: async () => linked,
  contact: async (id) => all.find((c) => c.id === id) ?? null,
})
const form = (over: Record<string, unknown>, contact_id: string | null = null, account_id: string | null = 'a1') =>
  ({ contact_id, account_id, submitted_data: { first_name: 'Bob', last_name: 'Roe', email: 'BOB@x.com', ...over } })

describe('resolveItinApplicant — MMLLC with two members', () => {
  it('name AND email agree on Bob: Bob — even when the form was linked to the other member', async () => {
    expect(await resolveItinApplicant(form({}, 'c-ann'), deps([ann, bob]))).toMatchObject({ ok: true, contactId: 'c-bob', fullName: 'Bob Roe' })
  })
  it('Bob fills with his WIFE\'s email (ann@x.com), which is Ann\'s: refused, nothing filed under Ann', async () => {
    const r = await resolveItinApplicant(form({ email: 'ann@x.com' }), deps([ann, bob]))
    expect(r.ok).toBe(false)
    expect(r.contactId).toBeNull()
    expect(r.message).toMatch(/email.*belongs to one member.*name is another/i)
  })
  it('same wife-email case with the form linked to Ann: still refused (the name says Bob)', async () => {
    expect((await resolveItinApplicant(form({ email: 'ann@x.com' }, 'c-ann'), deps([ann, bob]))).ok).toBe(false)
  })
  it('Bob with a different (unknown) email but his name: Bob, when the form is not linked elsewhere', async () => {
    expect(await resolveItinApplicant(form({ email: 'bob.new@y.com' }), deps([ann, bob]))).toMatchObject({ ok: true, contactId: 'c-bob' })
  })
  it('the name says Bob but staff linked the form to Ann and the email is unknown: refused (fix: link it to Bob)', async () => {
    expect((await resolveItinApplicant(form({ email: 'bob.new@y.com' }, 'c-ann'), deps([ann, bob]))).ok).toBe(false)
  })
  it('only the email points at a member (the name is unknown): accepted only when staff linked the form to that member', async () => {
    const odd = form({ first_name: 'Bobby', last_name: 'R.' }, 'c-bob')
    expect(await resolveItinApplicant(odd, deps([ann, bob]))).toMatchObject({ ok: true, contactId: 'c-bob' })
    expect((await resolveItinApplicant(form({ first_name: 'Bobby', last_name: 'R.' }, 'c-ann'), deps([ann, bob]))).ok).toBe(false)
    expect((await resolveItinApplicant(form({ first_name: 'Bobby', last_name: 'R.' }, null), deps([ann, bob]))).ok).toBe(false)
  })
  it('refuses (never "the first linked contact") when nothing identifies a member and nobody linked the form', async () => {
    const r = await resolveItinApplicant(form({ email: 'z@z.com', first_name: 'Cy', last_name: 'Dee' }, null), deps([ann, bob]))
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/which person/i)
  })
  it('nothing matches but staff linked the form to a member: that member', async () => {
    expect(await resolveItinApplicant(form({ email: 'q@q.com', first_name: 'Q', last_name: 'R' }, 'c-bob'), deps([ann, bob]))).toMatchObject({ ok: true, contactId: 'c-bob' })
  })
  it('nothing matches and the linked person is not a member of this company: refused', async () => {
    expect((await resolveItinApplicant(form({ email: 'q@q.com', first_name: 'Q', last_name: 'R' }, 'c-stranger'), deps([ann, bob]))).ok).toBe(false)
  })
})

describe('resolveItinApplicant — shared email, spelling, other shapes', () => {
  const sharedAnn = { ...ann, email: 'family@x.com' }
  const sharedBob = { ...bob, email: 'family@x.com' }
  it('two members share one email: the name decides', async () => {
    expect(await resolveItinApplicant(form({ email: 'family@x.com' }), deps([sharedAnn, sharedBob]))).toMatchObject({ ok: true, contactId: 'c-bob' })
  })
  it('shared email and a name nobody has: refused', async () => {
    expect((await resolveItinApplicant(form({ email: 'family@x.com', first_name: 'Cy', last_name: 'Dee' }), deps([sharedAnn, sharedBob]))).ok).toBe(false)
  })
  it("accents, curly apostrophes, name order and a left-out middle name do not matter", async () => {
    const dan: ItinContact = { id: 'c-dan', full_name: "Luca D'Angelo", email: null }
    const jose: ItinContact = { id: 'c-jose', full_name: 'José Pérez', email: null }
    const mid: ItinContact = { id: 'c-mid', full_name: 'Maria Teresa Bianchi', email: null }
    expect(await resolveItinApplicant(form({ email: '', first_name: 'Luca', last_name: 'D’Angelo' }), deps([ann, dan]))).toMatchObject({ ok: true, contactId: 'c-dan' })
    expect(await resolveItinApplicant(form({ email: '', first_name: 'Jose', last_name: 'Perez' }), deps([ann, jose]))).toMatchObject({ ok: true, contactId: 'c-jose' })
    expect(await resolveItinApplicant(form({ email: '', first_name: 'Maria', last_name: 'Bianchi' }), deps([ann, mid]))).toMatchObject({ ok: true, contactId: 'c-mid' })
  })
  it('a single-member company linked to that member, form with a typo name and email: that member', async () => {
    expect(await resolveItinApplicant(form({ email: 'typo@x.com', first_name: 'Zed', last_name: 'Q' }, 'c-ann'), deps([ann]))).toMatchObject({ ok: true, contactId: 'c-ann' })
  })
  it('a single-member company, form linked to nobody and nothing matches: refused', async () => {
    expect((await resolveItinApplicant(form({ email: 'q@q.com', first_name: 'Q' }, null), deps([ann]))).ok).toBe(false)
  })
  it('a lead-started form (no company) trusts the contact it is linked to; with none it is refused', async () => {
    expect(await resolveItinApplicant(form({}, 'c-bob', null), deps([], [ann, bob]))).toMatchObject({ ok: true, contactId: 'c-bob' })
    expect((await resolveItinApplicant(form({}, null, null), deps([]))).ok).toBe(false)
  })
  it('a database error is surfaced, not turned into "cannot tell which person"', async () => {
    const bad: ItinApplicantDeps = { linkedContacts: async () => { throw new Error('db blip') }, contact: async () => null }
    await expect(resolveItinApplicant(form({}), bad)).rejects.toThrow(/db blip/)
  })
})
