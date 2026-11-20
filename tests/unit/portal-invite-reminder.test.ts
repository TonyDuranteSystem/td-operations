import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildPortalInviteReminder } from '@/lib/jobs/portal-invite-reminder'
import { extractMembersFromWizardData, type NormalizedMember } from '@/lib/utils/wizard-members'

const person = (first: string, last: string, email: string | null, access: boolean | null): NormalizedMember => ({
  member_type: 'individual',
  member_first_name: first, member_last_name: last, member_email: email,
  member_ownership_pct: 20, member_dob: null, member_nationality: null, member_street: null, member_city: null,
  member_state_province: null, member_zip: null, member_country: null, member_needs_itin: null, is_signer: null,
  member_portal_access: access,
})
const company = (name: string | null, repEmail: string | null, access: boolean | null): NormalizedMember => ({
  member_type: 'company',
  member_company_name: name, member_company_ein: null, member_ownership_pct: 20,
  member_company_street: null, member_company_city: null, member_company_state: null, member_company_zip: null, member_company_country: null,
  member_rep_name: 'Rep', member_rep_email: repEmail, member_rep_phone: null,
  member_rep_address_street: null, member_rep_address_city: null, member_rep_address_state: null, member_rep_address_zip: null, member_rep_address_country: null,
  is_signer: null, member_portal_access: access,
})

describe('buildPortalInviteReminder', () => {
  it('lists every member, exactly as before, when nobody was unticked', () => {
    const r = buildPortalInviteReminder([person('Cal', 'One', 'cal@x.com', true), person('Dee', 'Two', 'dee@x.com', null)])
    expect(r.description).toBe('Create portal accounts for:\n• Cal One — cal@x.com\n• Dee Two — dee@x.com')
    expect(r.includedNames).toEqual(['Cal One', 'Dee Two'])
    expect(r.leftOutNames).toEqual([])
  })

  it('leaves an unticked member out of the list and names them in a separate note', () => {
    const r = buildPortalInviteReminder([person('Cal', 'One', 'cal@x.com', true), person('Dee', 'Two', 'dee@x.com', false)])
    expect(r.includedNames).toEqual(['Cal One'])
    expect(r.leftOutNames).toEqual(['Dee Two'])
    const [listPart, notePart] = (r.description as string).split('\n\n')
    expect(listPart).toBe('Create portal accounts for:\n• Cal One — cal@x.com')
    expect(listPart).not.toContain('Dee')
    expect(notePart).toContain('unticked')
    expect(notePart).toContain('• Dee Two — dee@x.com')
  })

  it('treats "no answer" (null) as still needing an account — only an explicit false is left out', () => {
    const r = buildPortalInviteReminder([person('Cal', 'One', 'cal@x.com', null), person('Dee', 'Two', 'dee@x.com', false)])
    expect(r.includedNames).toEqual(['Cal One'])
    expect(r.leftOutNames).toEqual(['Dee Two'])
  })

  it('returns no description when everyone was unticked', () => {
    const r = buildPortalInviteReminder([person('Cal', 'One', 'cal@x.com', false), company('Acme Inc', 'rep@acme.com', false)])
    expect(r.description).toBeNull()
    expect(r.includedNames).toEqual([])
    expect(r.leftOutNames).toEqual(['Cal One', 'Acme Inc'])
  })

  it('handles a company member: shows the representative email, and can be left out too', () => {
    const kept = buildPortalInviteReminder([company('Acme Inc', 'rep@acme.com', true)])
    expect(kept.description).toBe('Create portal accounts for:\n• Acme Inc (rep: rep@acme.com)')
    const out = buildPortalInviteReminder([person('Cal', 'One', 'cal@x.com', true), company('Acme Inc', null, false)])
    expect(out.leftOutNames).toEqual(['Acme Inc'])
    expect((out.description as string)).toContain('• Acme Inc (rep: no email)')
  })

  it('uses the form position for fallback names, even after members are left out', () => {
    const r = buildPortalInviteReminder([person('', '', 'a@x.com', false), person('', '', 'b@x.com', true), company(null, 'r@x.com', false)])
    expect(r.leftOutNames).toEqual(['Member 1', 'Company Member 3'])
    expect(r.includedNames).toEqual(['Member 2'])
  })

  it('shows "no email" for an included member with no email', () => {
    const r = buildPortalInviteReminder([person('Cal', 'One', null, true)])
    expect(r.description).toBe('Create portal accounts for:\n• Cal One — no email')
  })

  it('returns an empty, null-description result for no members', () => {
    expect(buildPortalInviteReminder([])).toEqual({ includedNames: [], leftOutNames: [], description: null })
  })

  it('works on what the form really sends: flat wizard keys with the tick unticked for one member', () => {
    const members = extractMembersFromWizardData({
      member_count: 2,
      member_0_member_first_name: 'Cal', member_0_member_last_name: 'OnbOne', member_0_member_email: 'cal@x.com', member_0_member_portal_access: true,
      member_1_member_first_name: 'Dee', member_1_member_last_name: 'OnbTwo', member_1_member_email: 'dee@x.com', member_1_member_portal_access: false,
    })
    const r = buildPortalInviteReminder(members)
    expect(r.includedNames).toEqual(['Cal OnbOne'])
    expect(r.leftOutNames).toEqual(['Dee OnbTwo'])
  })
})

describe('onboarding-setup wiring', () => {
  it('builds the staff reminder through the helper, never from the raw member list', () => {
    const src = readFileSync(join(process.cwd(), 'lib/jobs/handlers/onboarding-setup.ts'), 'utf8')
    expect(src).toContain('buildPortalInviteReminder(additionalMembers)')
    expect(src).toContain('description: reminder.description')
    expect(src).not.toMatch(/Create portal accounts for:\\n\$\{additionalMembers/)
  })
})
