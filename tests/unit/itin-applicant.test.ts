import { describe, it, expect } from 'vitest'
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
  it('picks the member who filled the form, even when the form was linked to the other one', async () => {
    const r = await resolveItinApplicant(form({}, 'c-ann'), deps([ann, bob]))
    expect(r).toMatchObject({ ok: true, contactId: 'c-bob' })
  })
  it('falls back to the exact name when the email does not match anyone', async () => {
    const r = await resolveItinApplicant(form({ email: 'other@y.com' }, null), deps([ann, bob]))
    expect(r).toMatchObject({ ok: true, contactId: 'c-bob' })
  })
  it('refuses (never "the first linked contact") when neither email nor name identifies a member and nobody linked the form', async () => {
    const r = await resolveItinApplicant(form({ email: 'z@z.com', first_name: 'Cy', last_name: 'Dee' }, null), deps([ann, bob]))
    expect(r.ok).toBe(false)
    expect(r.contactId).toBeNull()
    expect(r.message).toMatch(/which person/i)
  })
  it('refuses when two members share the email and the name does not settle it', async () => {
    const r = await resolveItinApplicant(form({ first_name: 'Cy', last_name: 'Dee' }), deps([{ ...ann, email: 'bob@x.com' }, bob]))
    expect(r.ok).toBe(false)
  })
})

describe('resolveItinApplicant — other shapes', () => {
  it('a single-member company linked to that member is certain', async () => {
    const r = await resolveItinApplicant(form({ email: 'typo@x.com', first_name: 'Robert' }, 'c-ann'), deps([ann]))
    expect(r).toMatchObject({ ok: true, contactId: 'c-ann' })
  })
  it('a single-member company with a form linked to nobody and no match is refused', async () => {
    expect((await resolveItinApplicant(form({ email: 'q@q.com', first_name: 'Q' }, null), deps([ann]))).ok).toBe(false)
  })
  it('a lead-started form (no company) trusts the contact it was matched to', async () => {
    const r = await resolveItinApplicant(form({}, 'c-bob', null), deps([], [ann, bob]))
    expect(r).toMatchObject({ ok: true, contactId: 'c-bob' })
  })
  it('a lead-started form with no contact is refused', async () => {
    expect((await resolveItinApplicant(form({}, null, null), deps([]))).ok).toBe(false)
  })
})

describe('resolveItinApplicant — the matrix', () => {
  const d = (linked: ItinContact[]) => deps(linked)
  it('Bob fills with his matching email', async () => {
    expect(await resolveItinApplicant(form({}), d([ann, bob]))).toMatchObject({ ok: true, contactId: 'c-bob', fullName: 'Bob Roe' })
  })
  it('Bob with a different email but the same name', async () => {
    expect(await resolveItinApplicant(form({ email: 'bob.new@y.com' }), d([ann, bob]))).toMatchObject({ ok: true, contactId: 'c-bob' })
  })
  it('two members share one email: the name decides', async () => {
    const sharedAnn = { ...ann, email: 'family@x.com' }
    const sharedBob = { ...bob, email: 'family@x.com' }
    expect(await resolveItinApplicant(form({ email: 'family@x.com' }), d([sharedAnn, sharedBob]))).toMatchObject({ ok: true, contactId: 'c-bob' })
  })
  it('shared email AND no usable name: refuses', async () => {
    const sharedAnn = { ...ann, email: 'family@x.com' }
    const sharedBob = { ...bob, email: 'family@x.com' }
    expect((await resolveItinApplicant(form({ email: 'family@x.com', first_name: 'Cy', last_name: 'Dee' }), d([sharedAnn, sharedBob]))).ok).toBe(false)
  })
  it("accents and curly apostrophes do not matter (D’Angelo = D'Angelo, José = Jose)", async () => {
    const dan: ItinContact = { id: 'c-dan', full_name: "Luca D'Angelo", email: null }
    const jose: ItinContact = { id: 'c-jose', full_name: 'José Pérez', email: null }
    expect(await resolveItinApplicant(form({ email: '', first_name: 'Luca', last_name: 'D’Angelo' }), d([ann, dan]))).toMatchObject({ ok: true, contactId: 'c-dan' })
    expect(await resolveItinApplicant(form({ email: '', first_name: 'Jose', last_name: 'Perez' }), d([ann, jose]))).toMatchObject({ ok: true, contactId: 'c-jose' })
  })
  it('nothing matches but staff linked the form to Bob (a member): Bob', async () => {
    expect(await resolveItinApplicant(form({ email: 'q@q.com', first_name: 'Q', last_name: 'R' }, 'c-bob'), d([ann, bob]))).toMatchObject({ ok: true, contactId: 'c-bob' })
  })
  it('nothing matches and the linked person is NOT a member of this company: refuses', async () => {
    expect((await resolveItinApplicant(form({ email: 'q@q.com', first_name: 'Q', last_name: 'R' }, 'c-stranger'), d([ann, bob]))).ok).toBe(false)
  })
  it('a database error is surfaced, not turned into "cannot tell which person"', async () => {
    const bad: ItinApplicantDeps = { linkedContacts: async () => { throw new Error('db blip') }, contact: async () => null }
    await expect(resolveItinApplicant(form({}), bad)).rejects.toThrow(/db blip/)
  })
})
