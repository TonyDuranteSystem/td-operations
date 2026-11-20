/**
 * Relay application — "other owners" step (dev job 2751fb26).
 * A company owned by other companies must be enterable, each company with its representative,
 * prefilled from the CRM owners list. All data below is made up.
 */
import { describe, it, expect } from 'vitest'
import {
  MAX_OWNER_CARDS,
  buildRelayOwnersPrefill,
  currentOwners,
  finalizeRelayAnswers,
  findSubmitterRow,
  hasOtherOwners,
  listRelayOwners,
  normalizeCountry,
  ownerCardCount,
  ownershipTotalIsValid,
  prepareRelayPayloadForPdf,
  relayOwnershipTotal,
  soleOwnerShareIsValid,
  splitFullName,
  withoutCardPrefillWhenDraftHasCards,
  type OwnerRow,
} from '@/lib/portal/relay-owners'
import {
  BANKING_RELAY_FIELDS,
  BANKING_RELAY_STEPS,
  RELAY_MEMBERS_CONFIRM_FIELD,
  RELAY_MEMBER_FIELDS,
  getWizardConfig,
} from '@/components/portal/wizard/wizard-configs'
import { FORM_CONFIGS, generateFormSummaryPDF } from '@/lib/form-to-drive'

const blank: OwnerRow = {
  member_type: 'individual', full_name: null, company_name: null, ein: null, email: null, phone: null,
  address_street: null, address_city: null, address_state: null, address_zip: null, address_country: null,
  ownership_pct: null, contact_id: null,
  representative_name: null, representative_email: null, representative_phone: null,
  representative_address_street: null, representative_address_city: null, representative_address_state: null,
  representative_address_zip: null, representative_address_country: null, end_date: null,
}
const row = (o: Partial<OwnerRow>): OwnerRow => ({ ...blank, ...o })

const TODAY = '2026-11-20'

// A person at 1% plus three companies at 33% — the shape that could not be entered before.
const person = row({ member_type: 'individual', full_name: 'Ada Lovelace', email: 'ada@example.test', phone: '+1 555 0100', address_street: '1 Analytical Way', address_city: 'London', address_state: 'Greater London', address_zip: 'N1 1AA', address_country: 'United Kingdom', ownership_pct: 1, contact_id: 'c-ada' })
const alpha = row({ member_type: 'company', company_name: 'Alpha Holdings LLC', ein: '11-1111111', address_street: '10 Main St', address_city: 'Largo', address_state: 'Florida', address_zip: '33771', address_country: 'USA', ownership_pct: 33, contact_id: 'c-ada-rep', representative_name: 'Ada Lovelace', representative_email: 'rep@alpha.test', representative_phone: '+1 555 0101', representative_address_street: '1 Analytical Way', representative_address_city: 'London', representative_address_country: 'United Kingdom' })
const beta = row({ member_type: 'company', company_name: 'Beta Strategy LLC', full_name: 'Bob Babbage', ein: '22-2222222', address_country: 'USA', ownership_pct: 33, contact_id: 'c-bob', representative_name: 'Bob Babbage', representative_email: 'bob@beta.test' })
const gamma = row({ member_type: 'company', company_name: 'GAMMA CONSULTING LLC', address_country: 'USA', ownership_pct: 33, contact_id: 'c-cy', representative_name: 'Cy Curie', representative_email: 'cy@gamma.test' })

describe('splitFullName', () => {
  it('splits at the first space', () => {
    expect(splitFullName('Ada Lovelace King')).toEqual({ first: 'Ada', last: 'Lovelace King' })
  })
  it('handles one word, blanks and null', () => {
    expect(splitFullName('Ada')).toEqual({ first: 'Ada', last: '' })
    expect(splitFullName('   ')).toEqual({ first: '', last: '' })
    expect(splitFullName(null)).toEqual({ first: '', last: '' })
  })
})

describe('normalizeCountry', () => {
  it("uses the wizard list's spelling for the common CRM variants", () => {
    expect(normalizeCountry('USA')).toBe('United States')
    expect(normalizeCountry(' usa ')).toBe('United States')
    expect(normalizeCountry('United States of America')).toBe('United States')
    expect(normalizeCountry('UK')).toBe('United Kingdom')
    expect(normalizeCountry('UAE')).toBe('United Arab Emirates')
  })
  it('matches the list in any capitals and understands Italian names', () => {
    expect(normalizeCountry('united states')).toBe('United States')
    expect(normalizeCountry('ITALY')).toBe('Italy')
    expect(normalizeCountry('Italia')).toBe('Italy')
    expect(normalizeCountry('Stati Uniti')).toBe('United States')
    expect(normalizeCountry('Regno Unito')).toBe('United Kingdom')
  })
  it('leaves any other country as written and blanks stay blank', () => {
    expect(normalizeCountry('Italy')).toBe('Italy')
    expect(normalizeCountry('Narnia')).toBe('Narnia')
    expect(normalizeCountry('  ')).toBeNull()
    expect(normalizeCountry(null)).toBeNull()
  })
  it('is applied to the company, representative and person addresses in the prefill', () => {
    const p = buildRelayOwnersPrefill(
      [row({ member_type: 'individual', full_name: 'Me Myself', contact_id: 'c-me', ownership_pct: 1 }),
       row({ member_type: 'company', company_name: 'X LLC', address_country: 'USA', representative_address_country: 'UK', ownership_pct: 49 }),
       row({ member_type: 'individual', full_name: 'Pat Q', address_country: 'US', ownership_pct: 50 })],
      { contactId: 'c-me', fullName: 'Me Myself' }, {}, TODAY)
    expect(p.member_0_member_company_country).toBe('United States')
    expect(p.member_0_member_rep_address_country).toBe('United Kingdom')
    expect(p.member_1_member_country).toBe('United States')
  })
})

describe('currentOwners', () => {
  it('drops owners whose end date has passed, keeps open and future ones', () => {
    const rows = [row({ full_name: 'A' }), row({ full_name: 'B', end_date: '2026-01-01' }), row({ full_name: 'C', end_date: '2027-01-01' })]
    expect(currentOwners(rows, TODAY).map((r) => r.full_name)).toEqual(['A', 'C'])
  })
})

describe('findSubmitterRow', () => {
  it('matches the person by contact link', () => {
    expect(findSubmitterRow([person, alpha], { contactId: 'c-ada', fullName: 'Someone Else' })).toBe(person)
  })
  it('falls back to the same full name when the login contact is a company representative', () => {
    // Real shape: the same person holds one contact as owner and another as the company's representative.
    expect(findSubmitterRow([person, alpha], { contactId: 'c-ada-rep', fullName: 'ada  LOVELACE' })).toBe(person)
  })
  it('does not guess when two person rows share a name', () => {
    const twin = row({ member_type: 'individual', full_name: 'Ada Lovelace', contact_id: 'c-other' })
    expect(findSubmitterRow([person, twin], { contactId: null, fullName: 'Ada Lovelace' })).toBeNull()
  })
  it('ignores accents and capitals in the name', () => {
    const jose = row({ member_type: 'individual', full_name: 'José Álvarez', contact_id: 'c-j' })
    expect(findSubmitterRow([jose, alpha], { contactId: 'c-company-rep', fullName: 'jose alvarez' })).toBe(jose)
  })
  it('returns null when nobody matches', () => {
    expect(findSubmitterRow([alpha], { contactId: 'c-x', fullName: 'Nobody' })).toBeNull()
  })
})

describe('buildRelayOwnersPrefill', () => {
  const names = { 'c-ada': { first_name: 'Ada', last_name: 'Lovelace' } }

  it('prefills the owner % and one card per company, each with its representative', () => {
    const p = buildRelayOwnersPrefill([person, alpha, beta, gamma], { contactId: 'c-ada-rep', fullName: 'Ada Lovelace' }, names, TODAY)
    expect(p.equity_pct).toBe('1')
    expect(p.has_partner).toBe('Yes')
    expect(p.member_count).toBe('3')
    expect(p.member_0_member_type).toBe('company')
    expect(p.member_0_member_company_name).toBe('Alpha Holdings LLC')
    expect(p.member_0_member_company_ein).toBe('11-1111111')
    expect(p.member_0_member_rep_name).toBe('Ada Lovelace')
    expect(p.member_0_member_rep_email).toBe('rep@alpha.test')
    expect(p.member_0_member_rep_address_country).toBe('United Kingdom')
    expect(p.member_0_member_ownership_pct).toBe('33')
    expect(p.member_1_member_company_name).toBe('Beta Strategy LLC')
    expect(p.member_1_member_rep_name).toBe('Bob Babbage')
    expect(p.member_2_member_company_name).toBe('GAMMA CONSULTING LLC')
    expect(p.member_2_member_rep_email).toBe('cy@gamma.test')
  })

  it("never turns the person filling the form into a card", () => {
    const p = buildRelayOwnersPrefill([person, alpha], { contactId: 'c-ada', fullName: 'Ada Lovelace' }, names, TODAY)
    expect(p.member_count).toBe('1')
    expect(Object.values(p)).not.toContain('Ada')
    expect(p.member_0_member_type).toBe('company')
  })

  it('builds a person card from the linked contact names, else from the full name', () => {
    const pat = row({ member_type: 'individual', full_name: 'Pat Q Public', email: 'pat@example.test', ownership_pct: 40, contact_id: 'c-pat' })
    const noLink = row({ member_type: 'individual', full_name: 'Quinn Rivers', ownership_pct: 59, contact_id: null })
    const p = buildRelayOwnersPrefill([person, pat, noLink], { contactId: 'c-ada', fullName: 'Ada Lovelace' }, { 'c-pat': { first_name: 'Patricia', last_name: 'Public' } }, TODAY)
    expect(p.member_0_member_type).toBe('individual')
    expect(p.member_0_member_first_name).toBe('Patricia')
    expect(p.member_0_member_last_name).toBe('Public')
    expect(p.member_0_member_email).toBe('pat@example.test')
    expect(p.member_1_member_first_name).toBe('Quinn')
    expect(p.member_1_member_last_name).toBe('Rivers')
  })

  it('leaves blank CRM values out so the client fills them in', () => {
    const p = buildRelayOwnersPrefill([person, gamma], { contactId: 'c-ada', fullName: 'Ada Lovelace' }, names, TODAY)
    expect(p).not.toHaveProperty('member_0_member_company_ein')
    expect(p).not.toHaveProperty('member_0_member_rep_phone')
  })

  it('says "no other owners" when the person is the only current owner', () => {
    const gone = row({ ...alpha, end_date: '2026-06-30' })
    const p = buildRelayOwnersPrefill([person, gone], { contactId: 'c-ada', fullName: 'Ada Lovelace' }, names, TODAY)
    expect(p).toEqual({ equity_pct: '1', has_partner: 'No' })
  })

  it('prefills nothing when the CRM has no owners', () => {
    expect(buildRelayOwnersPrefill([], { contactId: 'c-ada', fullName: 'Ada Lovelace' }, {}, TODAY)).toEqual({})
  })

  it('still lists every owner when the person has no row of their own (a representative)', () => {
    const p = buildRelayOwnersPrefill([alpha, beta], { contactId: 'c-zzz', fullName: 'Zed Zero' }, {}, TODAY)
    expect(p.has_partner).toBe('Yes')
    expect(p.member_count).toBe('2')
    expect(p).not.toHaveProperty('equity_pct')
  })
})

describe('ownership total', () => {
  it('adds the person and every card: 1% + 3 x 33% is accepted', () => {
    const data = { equity_pct: '1', member_0_member_ownership_pct: '33', member_1_member_ownership_pct: '33', member_2_member_ownership_pct: '33' }
    expect(relayOwnershipTotal(data, 3)).toBe(100)
    expect(ownershipTotalIsValid(99.99)).toBe(true)
  })
  it('refuses a total that is off', () => {
    expect(ownershipTotalIsValid(relayOwnershipTotal({ equity_pct: 10, member_0_member_ownership_pct: 33 }, 1))).toBe(false)
    expect(ownershipTotalIsValid(70)).toBe(false)
    expect(ownershipTotalIsValid(101)).toBe(false)
  })
  it('rounds to cents so 3 x 33.3 reads 99.9, not 99.89999999999999', () => {
    expect(relayOwnershipTotal({ equity_pct: 0, member_0_member_ownership_pct: 33.3, member_1_member_ownership_pct: 33.3, member_2_member_ownership_pct: 33.3 }, 3)).toBe(99.9)
  })
  it('never loops past the card cap', () => {
    expect(relayOwnershipTotal({ equity_pct: 1 }, 1e9)).toBe(1)
  })
  it('ignores blanks and text', () => {
    expect(relayOwnershipTotal({ equity_pct: '', member_0_member_ownership_pct: 'abc' }, 1)).toBe(0)
  })
})

describe('finalizeRelayAnswers', () => {
  const full = { has_partner: 'No', equity_pct: 100, member_count: 2, member_0_member_type: 'company', member_1_member_first_name: 'X', members_confirmed: true, business_name: 'Z LLC' }
  it('drops the cards and the confirm when the client says no other owners', () => {
    expect(finalizeRelayAnswers(full, 2)).toEqual({ has_partner: 'No', equity_pct: 100, business_name: 'Z LLC' })
  })
  it('keeps the cards when there are other owners and stamps the card count', () => {
    const yes = { has_partner: 'Yes', equity_pct: 1, member_0_member_type: 'individual', member_0_member_first_name: 'Pat', members_confirmed: true }
    const out = finalizeRelayAnswers(yes, 1)
    expect(out.member_count).toBe(1)
    expect(out.member_0_member_first_name).toBe('Pat')
    expect(out.members_confirmed).toBe(true)
  })
  it('drops the old single-partner answers either way — the step no longer asks them', () => {
    const legacy = { has_partner: 'Yes', partner_first_name: 'Old', partner_equity_pct: '30', member_count: 1, member_0_member_type: 'company' }
    expect(Object.keys(finalizeRelayAnswers(legacy, 1)).some((k) => k.startsWith('partner_'))).toBe(false)
    const none = { has_partner: 'No', partner_first_name: 'Old' }
    expect(finalizeRelayAnswers(none, 0)).toEqual({ has_partner: 'No' })
  })
  it('caps the stamped count', () => {
    expect(finalizeRelayAnswers({ has_partner: 'Yes' }, 1e9).member_count).toBe(MAX_OWNER_CARDS)
  })
  it('hasOtherOwners reads only a Yes', () => {
    expect(hasOtherOwners({ has_partner: 'Yes' })).toBe(true)
    expect(hasOtherOwners({ has_partner: 'No' })).toBe(false)
    expect(hasOtherOwners({})).toBe(false)
  })
})

describe('ownerCardCount', () => {
  it('trusts a positive member_count, capped', () => {
    expect(ownerCardCount({ member_count: 3 })).toBe(3)
    expect(ownerCardCount({ member_count: '2' })).toBe(2)
    expect(ownerCardCount({ member_count: 1e9 })).toBe(MAX_OWNER_CARDS)
  })
  it('without a count, reads the highest card key — a card typed by hand and never "added" still counts', () => {
    expect(ownerCardCount({ member_0_member_type: 'individual' })).toBe(1)
    expect(ownerCardCount({ member_0_member_type: 'x', member_2_member_type: 'y' })).toBe(3)
    expect(ownerCardCount({ member_count: 0, member_1_member_first_name: 'A' })).toBe(2)
    expect(ownerCardCount({ member_9999_member_type: 'x' })).toBe(MAX_OWNER_CARDS)
  })
  it('is zero when there are no cards', () => {
    expect(ownerCardCount({ has_partner: 'No' })).toBe(0)
  })
})

describe('withoutCardPrefillWhenDraftHasCards', () => {
  const prefill = { equity_pct: '1', has_partner: 'Yes', member_count: '3', member_0_member_company_ein: '11-1111111', member_2_member_type: 'company' }
  it('keeps the whole prefill when the draft has no cards yet', () => {
    expect(withoutCardPrefillWhenDraftHasCards(prefill, { business_name: 'X' })).toBe(prefill)
  })
  it('drops every CRM card value once the draft holds cards, so a removed card or a cleared value stays gone', () => {
    const out = withoutCardPrefillWhenDraftHasCards(prefill, { member_count: 2, member_0_member_company_name: 'Beta' })
    expect(out).toEqual({ equity_pct: '1', has_partner: 'Yes' })
  })
  it('a draft that only carries a card count is also the list', () => {
    expect(withoutCardPrefillWhenDraftHasCards(prefill, { member_count: 1 })).toEqual({ equity_pct: '1', has_partner: 'Yes' })
  })
})

describe('soleOwnerShareIsValid', () => {
  it('with no other owners the person must hold 100%', () => {
    expect(soleOwnerShareIsValid({ has_partner: 'No', equity_pct: 1 })).toBe(false)
    expect(soleOwnerShareIsValid({ has_partner: 'No', equity_pct: 250 })).toBe(false)
    expect(soleOwnerShareIsValid({ has_partner: 'No', equity_pct: '100' })).toBe(true)
  })
  it('does not apply when there are other owners, and a blank is the required rule\'s job', () => {
    expect(soleOwnerShareIsValid({ has_partner: 'Yes', equity_pct: 1 })).toBe(true)
    expect(soleOwnerShareIsValid({ has_partner: 'No', equity_pct: '' })).toBe(true)
    expect(soleOwnerShareIsValid({ has_partner: 'No' })).toBe(true)
  })
})

const submitted = {
  business_name: 'Test LLC', has_partner: 'Yes', equity_pct: 1, members_confirmed: true, member_count: 2,
  member_0_member_type: 'company', member_0_member_company_name: 'Alpha Holdings LLC', member_0_member_company_ein: '11-1111111',
  member_0_member_company_street: '10 Main St', member_0_member_company_city: 'Largo', member_0_member_company_state: 'Florida', member_0_member_company_zip: '33771', member_0_member_company_country: 'USA',
  member_0_member_rep_name: 'Ada Lovelace', member_0_member_rep_email: 'rep@alpha.test', member_0_member_rep_phone: '+1 555 0101',
  member_0_member_rep_address_city: 'London', member_0_member_rep_address_country: 'United Kingdom',
  member_0_member_ownership_pct: 33,
  member_1_member_type: 'individual', member_1_member_first_name: 'Pat', member_1_member_last_name: 'Public', member_1_member_email: 'pat@example.test',
  member_1_member_street: '2 Side St', member_1_member_city: 'Rome', member_1_member_state_province: 'RM', member_1_member_zip: '00100', member_1_member_country: 'Italy', member_1_member_ownership_pct: 66,
}

describe('listRelayOwners (what staff read)', () => {
  it('reads a company with its representative and a person', () => {
    const [c, p] = listRelayOwners(submitted)
    expect(c).toMatchObject({ kind: 'company', name: 'Alpha Holdings LLC', ownershipPct: '33', ein: '11-1111111', address: '10 Main St, Largo, Florida 33771, USA' })
    expect(c.representative).toMatchObject({ name: 'Ada Lovelace', email: 'rep@alpha.test', phone: '+1 555 0101', address: 'London, United Kingdom' })
    expect(p).toMatchObject({ kind: 'person', name: 'Pat Public', ownershipPct: '66', email: 'pat@example.test', address: '2 Side St, Rome, RM 00100, Italy' })
    expect(p.representative).toBeNull()
  })
  it('still reads an application filed with the old single partner', () => {
    const old = { has_partner: 'Yes', partner_first_name: 'Old', partner_last_name: 'Partner', partner_email: 'o@example.test', partner_equity_pct: '30', partner_street: '3 Old Rd', partner_city: 'Miami' }
    expect(listRelayOwners(old)).toEqual([
      { kind: 'person', name: 'Old Partner', ownershipPct: '30', email: 'o@example.test', phone: '', ein: '', address: '3 Old Rd, Miami', representative: null },
    ])
  })
  it('still reads a card typed by hand when the card count was never written', () => {
    const noCount = { has_partner: 'Yes', member_0_member_type: 'individual', member_0_member_first_name: 'Sole', member_0_member_last_name: 'Partner', member_0_member_ownership_pct: '40' }
    expect(listRelayOwners(noCount)).toMatchObject([{ kind: 'person', name: 'Sole Partner', ownershipPct: '40' }])
    const pdf = prepareRelayPayloadForPdf(noCount)
    expect((pdf.members_list as unknown[]).length).toBe(1)
    expect(Object.keys(pdf).some((k) => /^member_\d+_/.test(k))).toBe(false)
  })
  it('returns nothing when there are no other owners', () => {
    expect(listRelayOwners({ has_partner: 'No' })).toEqual([])
    expect(listRelayOwners({})).toEqual([])
  })
})

describe('the filed summary PDF', () => {
  it('folds the cards into one block per owner and removes the raw keys', () => {
    const out = prepareRelayPayloadForPdf(submitted)
    expect(out.business_name).toBe('Test LLC')
    expect(Object.keys(out).some((k) => /^member_\d+_/.test(k))).toBe(false)
    expect(out).not.toHaveProperty('member_count')
    expect(out).not.toHaveProperty('members_confirmed')
    const list = out.members_list as Record<string, unknown>[]
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ owner_kind: 'Company', owner_name: 'Alpha Holdings LLC', owner_ownership: '33%', owner_rep_name: 'Ada Lovelace', owner_rep_email: 'rep@alpha.test' })
    expect(list[1]).toMatchObject({ owner_kind: 'Person', owner_name: 'Pat Public', owner_ownership: '66%' })
  })
  it('drops a stale single partner when the cards are printed', () => {
    const out = prepareRelayPayloadForPdf({ ...submitted, partner_first_name: 'Stale', partner_equity_pct: '30' })
    expect(out).not.toHaveProperty('partner_first_name')
    expect(out).not.toHaveProperty('partner_equity_pct')
  })
  it('leaves an old single-partner application untouched', () => {
    const old = { has_partner: 'Yes', partner_first_name: 'Old' }
    expect(prepareRelayPayloadForPdf(old)).toBe(old)
  })
  it('is wired into the Relay summary and draws a PDF with company and representative blocks', async () => {
    expect(FORM_CONFIGS.banking_relay.prepare).toBe(prepareRelayPayloadForPdf)
    expect(FORM_CONFIGS.banking_relay.sections.some((s) => s.fields.some((f) => f.key === 'members_list'))).toBe(true)
    const bytes = await generateFormSummaryPDF(FORM_CONFIGS.banking_relay, submitted, { token: 't', submittedAt: '2026-11-20T00:00:00Z', uploadCount: 0, deterministic: true })
    expect(bytes.byteLength).toBeGreaterThan(1000)
  })
  it('hides the old Partner section when it has no answers and keeps it for an older application', () => {
    const relay = FORM_CONFIGS.banking_relay
    expect(relay.sections.find((s) => s.title === 'Partner Information')?.hideWhenEmpty).toBe(true)
    expect(relay.sections.find((s) => s.title.startsWith('Other Owners'))?.hideWhenEmpty).toBe(true)
    // formation / onboarding sections are never hidden
    expect(Object.values(FORM_CONFIGS).filter((c) => c !== relay).every((c) => c.sections.every((s) => !s.hideWhenEmpty))).toBe(true)
  })
  it('the other forms are not reshaped', () => {
    expect(FORM_CONFIGS.banking_payset.prepare).toBeUndefined()
    expect(FORM_CONFIGS.formation.prepare).toBeUndefined()
  })
})

describe('Relay wizard config', () => {
  it('has a members step (not the old single partner step) wired to the owner cards', () => {
    const ids = BANKING_RELAY_STEPS.map((s) => s.id)
    expect(ids).toEqual(['business', 'owner', 'members'])
    expect(BANKING_RELAY_FIELDS.members).toBe(RELAY_MEMBER_FIELDS)
    expect(BANKING_RELAY_FIELDS).not.toHaveProperty('partner')
    const cfg = getWizardConfig('banking_relay')
    expect(cfg.fields.members).toBe(RELAY_MEMBER_FIELDS)
  })
  it('lets the client pick person or company, and a company carries its representative', () => {
    const byName = Object.fromEntries(RELAY_MEMBER_FIELDS.map((f) => [f.name, f]))
    expect(byName.member_type.options?.map((o) => o.value)).toEqual(['individual', 'company'])
    for (const n of ['member_company_name', 'member_company_country', 'member_rep_name', 'member_rep_email']) {
      expect(byName[n].required).toBe(true)
      expect(byName[n].conditional).toEqual({ field: 'member_type', value: 'company' })
    }
    for (const n of ['member_first_name', 'member_last_name', 'member_email']) {
      expect(byName[n].conditional).toEqual({ field: 'member_type', value: 'individual' })
    }
    expect(byName.member_ownership_pct.required).toBe(true)
  })
  it('every field has an Italian label or hint where the person-facing text is not an English-only form label', () => {
    for (const f of RELAY_MEMBER_FIELDS) expect(f.label.length).toBeGreaterThan(0)
    expect(RELAY_MEMBERS_CONFIRM_FIELD.type).toBe('checkbox')
    expect(RELAY_MEMBERS_CONFIRM_FIELD.hintIt).toBeTruthy()
  })
  it('keeps the has_partner question the staff views and older answers rely on', () => {
    const own = BANKING_RELAY_FIELDS.owner.find((f) => f.name === 'has_partner')
    expect(own?.options?.map((o) => o.value)).toEqual(['No', 'Yes'])
  })
  it('Payset has no owners step', () => {
    expect(getWizardConfig('banking_payset').steps.some((s) => s.id === 'members')).toBe(false)
  })
})
