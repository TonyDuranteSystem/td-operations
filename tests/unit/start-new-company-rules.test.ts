/**
 * "Start a new company" — the pure rules (lib/operations/start-new-company-rules.ts), dev job bf9886a3.
 */
import { describe, it, expect } from 'vitest'
import {
  COMPANY_REPLACED_REASON,
  MESSAGE_BEING_SENT_TEXT,
  MESSAGE_CLAIM_LIVE_MS,
  MESSAGE_SENT_MARKER,
  WIZARD_REOPENED_MARKER,
  buildReplacementMessage,
  clientMessageState,
  describeWaitingPart,
  isReplacementOf,
  messageClaimNote,
  messageFailedNote,
  namesFromReopenedNote,
  newJobFailureText,
  replaceBlockers,
  replacementNote,
  seedReopenedWizardData,
  wasCancelledByCompanyReplacement,
  wizardNamesOf,
  wizardNothingToReopenNote,
  wizardReopenedNote,
} from '@/lib/operations/start-new-company-rules'
import { localeFromLanguage } from '@/lib/locale'

describe('Italian detection uses the shared helper', () => {
  // The values real clients carry in contacts.language (lib/locale.ts header lists them).
  const cases = ['Italian', 'Italiano', 'it', 'IT', ' it ', 'Italian - englis', 'it-IT', 'it_IT']
  for (const language of cases) {
    it(`"${language}" gets the Italian draft, exactly when the rest of the system calls it Italian`, () => {
      const m = buildReplacementMessage({ language, firstName: 'Ugo', oldCompanyName: 'Novag LLC' })
      expect(m.startsWith('Ciao Ugo,')).toBe(true)
      expect(localeFromLanguage(language)).toBe('it')
    })
  }
  for (const language of ['English', 'en', '', null, undefined, 'French']) {
    it(`${JSON.stringify(language)} gets the English draft`, () => {
      expect(buildReplacementMessage({ language, firstName: 'Sam', oldCompanyName: 'X LLC' }).startsWith('Hi Sam,')).toBe(true)
    })
  }
})

describe('the "wizard reopened" note', () => {
  it('carries the marker and the names the client had given', () => {
    const note = wizardReopenedNote('2026-11-16', ['Novag LLC', 'Novag Group LLC'])
    expect(note).toContain(WIZARD_REOPENED_MARKER)
    expect(namesFromReopenedNote(`first line\n${note}\nlast line`)).toEqual(['Novag LLC', 'Novag Group LLC'])
  })

  it('keeps a name that itself ends with a full stop', () => {
    expect(namesFromReopenedNote(wizardReopenedNote('2026-11-16', ['Novag Inc.', 'Novag Co']))).toEqual(['Novag Inc.', 'Novag Co'])
  })

  it('has no names to give back when the wizard held none, or the notes are empty', () => {
    expect(namesFromReopenedNote(wizardReopenedNote('2026-11-16', []))).toEqual([])
    expect(namesFromReopenedNote(null)).toEqual([])
    expect(namesFromReopenedNote('')).toEqual([])
  })

  it('has a stable marker', () => {
    expect(WIZARD_REOPENED_MARKER).toBe('Wizard reopened')
  })
})

describe('buildReplacementMessage', () => {
  it('is Italian for an Italian client and names the refused company', () => {
    const m = buildReplacementMessage({ language: 'Italian', firstName: 'Mario', oldCompanyName: 'Novag LLC' })
    expect(m.startsWith('Ciao Mario,')).toBe(true)
    expect(m).toContain('Novag LLC')
    expect(m).toContain('non devi pagare di nuovo')
  })

  it('accepts the short codes for Italian', () => {
    expect(buildReplacementMessage({ language: 'it', firstName: 'A', oldCompanyName: 'X LLC' })).toContain('Ciao A,')
    expect(buildReplacementMessage({ language: ' IT ', firstName: 'A', oldCompanyName: 'X LLC' })).toContain('Ciao A,')
  })

  it('is English for anyone else, and when the language is missing', () => {
    expect(buildReplacementMessage({ language: 'English', firstName: 'Sam', oldCompanyName: 'X LLC' })).toContain('Hi Sam,')
    expect(buildReplacementMessage({ language: null, firstName: 'Sam', oldCompanyName: 'X LLC' })).toContain('Hi Sam,')
  })

  it('does not break without a first name', () => {
    expect(buildReplacementMessage({ language: 'Italian', firstName: null, oldCompanyName: 'X LLC' }).startsWith('Ciao,')).toBe(true)
    expect(buildReplacementMessage({ language: 'English', firstName: '  ', oldCompanyName: 'X LLC' }).startsWith('Hi,')).toBe(true)
  })

  it('never promises anything that is not true: no new payment now, second part only "if there is one"', () => {
    const it = buildReplacementMessage({ language: 'Italian', firstName: 'M', oldCompanyName: 'X' })
    expect(it).toContain('se prevista')
    const en = buildReplacementMessage({ language: 'English', firstName: 'M', oldCompanyName: 'X' })
    expect(en).toContain('if there is one')
  })
})

describe('seedReopenedWizardData', () => {
  const old = {
    first_name: 'Mario',
    llc_name_1: 'Novag LLC',
    llc_name_2: 'Novag Marketing LLC',
    llc_name_3: 'Novag Professional LLC',
    business_purpose: 'Social media marketing',
    disclaimer_accepted: true,
    passport_owner: ['formation/x/passport.jpg'],
    member_0_member_first_name: 'Barbarino',
  }

  it('keeps the people and documents, drops the names and the disclaimer', () => {
    const seeded = seedReopenedWizardData(old)
    expect(seeded).toEqual({
      first_name: 'Mario',
      business_purpose: 'Social media marketing',
      passport_owner: ['formation/x/passport.jpg'],
      member_0_member_first_name: 'Barbarino',
    })
  })

  it('never changes its input', () => {
    const copy = JSON.parse(JSON.stringify(old))
    seedReopenedWizardData(old)
    expect(old).toEqual(copy)
  })

  it('handles an empty or missing wizard', () => {
    expect(seedReopenedWizardData(null)).toEqual({})
    expect(seedReopenedWizardData(undefined)).toEqual({})
    expect(seedReopenedWizardData({})).toEqual({})
  })
})

describe('wizardNamesOf', () => {
  it('lists the names in order and skips blanks', () => {
    expect(wizardNamesOf({ llc_name_2: 'B LLC', llc_name_1: 'A LLC', llc_name_3: '  ', other: 'x' })).toEqual(['A LLC', 'B LLC'])
  })
  it('is empty for no data', () => {
    expect(wizardNamesOf(null)).toEqual([])
  })
})

describe('replaceBlockers', () => {
  const ok = { jobStatus: 'active', hasCompany: true, sourceOfferToken: 'offer-1', offerFound: true, unpaidInvoices: 0, leaseInForce: 0 }

  it('has no blocker for a normal company', () => {
    expect(replaceBlockers(ok)).toEqual([])
  })

  it('refuses a job that is not active', () => {
    expect(replaceBlockers({ ...ok, jobStatus: 'cancelled' })).toHaveLength(1)
    expect(replaceBlockers({ ...ok, jobStatus: null })).toHaveLength(1)
  })

  it('refuses a formation that has no company yet (the name check on the job is for that)', () => {
    expect(replaceBlockers({ ...ok, hasCompany: false })[0]).toContain('name check')
  })

  it('refuses when the payment could not follow: no offer token, or the offer is missing', () => {
    expect(replaceBlockers({ ...ok, sourceOfferToken: null })[0]).toContain('not tied to an offer')
    expect(replaceBlockers({ ...ok, offerFound: false })[0]).toContain('could not be found')
  })

  it('hands money and leases back to a human', () => {
    expect(replaceBlockers({ ...ok, unpaidInvoices: 1 })[0]).toContain('1 unpaid invoice.')
    expect(replaceBlockers({ ...ok, unpaidInvoices: 2 })[0]).toContain('2 unpaid invoices')
    expect(replaceBlockers({ ...ok, leaseInForce: 1 })[0]).toContain('lease')
  })

  it('lists every reason, not just the first', () => {
    expect(replaceBlockers({ ...ok, unpaidInvoices: 1, leaseInForce: 1 })).toHaveLength(2)
  })
})

describe('describeWaitingPart', () => {
  const plan = [
    { seq: 1, amount: 1900, currency: 'EUR', trigger: { kind: 'signing' } },
    { seq: 2, amount: 1900, currency: 'EUR', trigger: { kind: 'step', service_type: 'Company Formation', stage: 'EIN Received', label: 'After the EIN arrives' } },
  ]

  it('names the part that waits for a formation step, with its client-visible label', () => {
    const s = describeWaitingPart(plan)
    expect(s).toContain('Part 2')
    expect(s).toContain('1,900 EUR')
    expect(s).toContain('After the EIN arrives')
  })

  it('falls back to the step name when there is no label', () => {
    const s = describeWaitingPart([{ seq: 2, amount: 100, currency: 'USD', trigger: { kind: 'step', service_type: 'company formation', stage: 'EIN Received' } }])
    expect(s).toContain('EIN Received')
  })

  it('says nothing for a plan with no formation step, or no plan at all', () => {
    expect(describeWaitingPart([{ seq: 1, amount: 100, trigger: { kind: 'date' } }])).toBeNull()
    expect(describeWaitingPart([{ seq: 2, trigger: { kind: 'step', service_type: 'ITIN', stage: 'x' } }])).toBeNull()
    expect(describeWaitingPart(null)).toBeNull()
    expect(describeWaitingPart('nope')).toBeNull()
  })
})

describe('describeWaitingPart skips a part that already has an invoice', () => {
  const plan = [
    { seq: 1, amount: 1900, currency: 'EUR', trigger: { kind: 'signing' } },
    { seq: 2, amount: 1900, currency: 'EUR', trigger: { kind: 'step', service_type: 'Company Formation', stage: 'EIN Received', label: 'After the EIN arrives' } },
  ]

  it('still names the waiting part when nothing is invoiced yet', () => {
    expect(describeWaitingPart(plan, [1])).toContain('Part 2')
    expect(describeWaitingPart(plan, [])).toContain('Part 2')
  })

  it('says nothing once that part has been invoiced — it no longer waits', () => {
    expect(describeWaitingPart(plan, [2])).toBeNull()
    expect(describeWaitingPart(plan, [1, 2])).toBeNull()
  })
})

describe('the replacement note', () => {
  it('is recognised for the job it replaced and only that one', () => {
    const note = replacementNote('11111111-aaaa', 'Novag LLC', '2026-11-16', 'staff@example.com')
    expect(isReplacementOf(note, '11111111-aaaa')).toBe(true)
    expect(isReplacementOf(note, '22222222-bbbb')).toBe(false)
    expect(isReplacementOf(null, '11111111-aaaa')).toBe(false)
  })

  it('does not match a longer id that merely starts the same way', () => {
    const note = replacementNote('11111111-aaaa', 'X', '2026-11-16', 'me')
    expect(isReplacementOf(note, '11111111')).toBe(false)
  })

  it('has a stable marker for "the message already went out"', () => {
    expect(MESSAGE_SENT_MARKER).toBe('Client message sent')
  })
})

describe('newJobFailureText', () => {
  it('turns the duplicate-key error of a simultaneous press into a plain sentence', () => {
    const t = newJobFailureText('dbWrite[service_deliveries.insert]: duplicate key value violates unique constraint "uq_formation_sd_active_per_offer"')
    expect(t).toContain('same moment')
    expect(t).not.toContain('uq_formation')
    expect(t).not.toContain('dbWrite')
  })
  it('keeps any other reason as it is', () => {
    expect(newJobFailureText('database busy')).toBe('The new formation could not be opened: database busy')
    expect(newJobFailureText('')).toBe('The new formation could not be opened: unknown error')
  })
})

describe('the "nothing to reopen" note', () => {
  it('carries the same marker as a real reopen, so a repeated press leaves the wizard alone', () => {
    expect(wizardNothingToReopenNote('2026-11-17')).toContain(WIZARD_REOPENED_MARKER)
  })
  it('has no names to give back', () => {
    expect(namesFromReopenedNote(wizardNothingToReopenNote('2026-11-17'))).toEqual([])
  })
})

describe('the older single-name wizard shapes', () => {
  it('are cleared when the wizard is reopened, so the refused name cannot come back through them', () => {
    const seeded = seedReopenedWizardData({
      llc_name_1: 'Novag LLC', llc_name: 'Novag LLC', company_name: 'Novag LLC', business_name: 'Novag', chosen_name: 'Novag LLC', chosen_name_final: 'Novag LLC',
      members: [{ name: 'Ugo' }], business_purpose: 'Marketing',
    })
    expect(seeded).toEqual({ members: [{ name: 'Ugo' }], business_purpose: 'Marketing' })
  })

  it('are remembered for the history note, once each', () => {
    // keys are read in alphabetical order: chosen_name_final, company_name, llc_name_1 (a repeat of the first)
    expect(wizardNamesOf({ llc_name_1: 'A LLC', chosen_name_final: 'A LLC', company_name: 'B LLC', other: 'x' })).toEqual(['A LLC', 'B LLC'])
  })
})

describe('a job cancelled because its company was replaced', () => {
  it('is recognised by the status AND the words the button writes', () => {
    const notes = `2026-11-17 — Service deactivated: ${COMPANY_REPLACED_REASON} (job n1).`
    expect(wasCancelledByCompanyReplacement('cancelled', notes)).toBe(true)
  })

  it('is not recognised when a person cancelled it, or it is still running, or there are no notes', () => {
    expect(wasCancelledByCompanyReplacement('cancelled', '2026-11-17 — Service deactivated: client changed their mind')).toBe(false)
    expect(wasCancelledByCompanyReplacement('active', COMPANY_REPLACED_REASON)).toBe(false)
    expect(wasCancelledByCompanyReplacement('cancelled', null)).toBe(false)
    expect(wasCancelledByCompanyReplacement(null, undefined)).toBe(false)
  })
})

describe('where the client message stands (claim before send, 2026-11-17)', () => {
  const now = new Date('2026-11-17T12:00:00.000Z')
  const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString()

  it('is open when the notes say nothing about the message', () => {
    expect(clientMessageState(null, now)).toBe('open')
    expect(clientMessageState('', now)).toBe('open')
    expect(clientMessageState('2026-11-17 — Wizard reopened for the new names.', now)).toBe('open')
  })
  it('is sending while a claim is fresh', () => {
    expect(clientMessageState(messageClaimNote('2026-11-17', at(5_000)), now)).toBe('sending')
    expect(clientMessageState(messageClaimNote('2026-11-17', at(MESSAGE_CLAIM_LIVE_MS - 1)), now)).toBe('sending')
  })
  it('is open again once a claim is two minutes old (the press that made it is gone)', () => {
    expect(clientMessageState(messageClaimNote('2026-11-17', at(MESSAGE_CLAIM_LIVE_MS)), now)).toBe('open')
    expect(clientMessageState(messageClaimNote('2026-11-17', at(10 * 60_000)), now)).toBe('open')
  })
  it('is sent as soon as the sent line is there, whatever else the notes say', () => {
    const notes = [messageClaimNote('2026-11-17', at(1_000)), '2026-11-17 — Client message sent (Italian).'].join('\n')
    expect(clientMessageState(notes, now)).toBe('sent')
  })
  it('is open again when the claim was let go after a failed send, and the next claim counts', () => {
    const failed = [messageClaimNote('2026-11-17', at(20_000)), messageFailedNote('2026-11-17', at(15_000), 'chat is down')].join('\n')
    expect(clientMessageState(failed, now)).toBe('open')
    const reclaimed = [failed, messageClaimNote('2026-11-17', at(2_000))].join('\n')
    expect(clientMessageState(reclaimed, now)).toBe('sending')
  })
  it('treats a claim without a readable time as open, so it can never block for good', () => {
    expect(clientMessageState('2026-11-17 — Client message sending (started soon).', now)).toBe('open')
  })
  it('keeps a failure reason on one short line', () => {
    const note = messageFailedNote('2026-11-17', at(0), 'line one\nline two ' + 'x'.repeat(500))
    expect(note.split('\n')).toHaveLength(1)
    expect(note.length).toBeLessThan(330)
    expect(messageFailedNote('2026-11-17', at(0), '')).toContain('unknown error')
  })
  it('does not mistake the sending or not-sent lines for the sent line', () => {
    expect(messageClaimNote('2026-11-17', at(0)).includes(MESSAGE_SENT_MARKER)).toBe(false)
    expect(messageFailedNote('2026-11-17', at(0), 'x').includes(MESSAGE_SENT_MARKER)).toBe(false)
  })
  it('tells the person who pressed second what happened, in plain words', () => {
    expect(MESSAGE_BEING_SENT_TEXT).toContain('sending the client')
    expect(MESSAGE_BEING_SENT_TEXT).toContain('did not send the message or cancel')
  })
})
