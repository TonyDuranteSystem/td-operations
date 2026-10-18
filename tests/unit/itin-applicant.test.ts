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
  it('refuses (never "the first linked contact") when neither email nor name identifies a member', async () => {
    const r = await resolveItinApplicant(form({ email: 'z@z.com', first_name: 'Cy', last_name: 'Dee' }, 'c-ann'), deps([ann, bob]))
    expect(r.ok).toBe(false)
    expect(r.contactId).toBeNull()
    expect(r.message).toMatch(/which person/i)
  })
  it('refuses when two members share the email', async () => {
    const r = await resolveItinApplicant(form({}), deps([{ ...ann, email: 'bob@x.com' }, bob]))
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
