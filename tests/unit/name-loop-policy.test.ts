/**
 * lib/flows/name-loop-policy.ts — the one place where Company Formation and Company Change
 * Name differ in the names loop, and ALL the client-facing wording of the loop.
 */
import { describe, it, expect } from 'vitest'
import {
  nameLoopPolicyFor,
  canAddNameAtStage,
  approvalCopy,
  newNamesCopy,
  firstNamesCopy,
  proposalChatNote,
  displayNameFor,
} from '@/lib/flows/name-loop-policy'

const formation = nameLoopPolicyFor('Company Formation')!
const change = nameLoopPolicyFor('Company Change Name')!

describe('nameLoopPolicyFor', () => {
  it('knows exactly two services and nothing else', () => {
    expect(formation).not.toBeNull()
    expect(change).not.toBeNull()
    for (const t of ['ITIN', 'Tax Return', 'EIN Change Name', '', null, undefined]) expect(nameLoopPolicyFor(t as never)).toBeNull()
  })

  it('Company Formation keeps today\'s behaviour exactly', () => {
    expect(formation).toMatchObject({
      seedFromFormationWizard: true,
      addNameStages: ['Wizard Submitted'],
      oneAtATime: false,
      newNamesCount: 3,
      firstNamesCount: 0,
      split: 'all',
      stateRule: 'formation_chain',
      revertStageOnSosRejected: 'Wizard Submitted',
      formationPanelExtras: true,
    })
  })

  it('Company Change Name: no seeding, any stage, one at a time, one new name, own state, no automatic stage revert', () => {
    expect(change).toMatchObject({
      seedFromFormationWizard: false,
      addNameStages: null,
      oneAtATime: true,
      newNamesCount: 1,
      firstNamesCount: 3,
      split: 'lines',
      stateRule: 'account_required',
      revertStageOnSosRejected: null,
      formationPanelExtras: false,
    })
  })
})

describe('canAddNameAtStage', () => {
  it('Formation: only at the name-selection stage', () => {
    expect(canAddNameAtStage(formation, 'Wizard Submitted')).toBe(true)
    expect(canAddNameAtStage(formation, 'Filed with State')).toBe(false)
    expect(canAddNameAtStage(formation, null)).toBe(false)
  })
  it('Company Change Name: wherever the layout shows the panel', () => {
    expect(canAddNameAtStage(change, 'Collect three company names')).toBe(true)
    expect(canAddNameAtStage(change, null)).toBe(true)
  })
})

describe('client wording', () => {
  it('the approval card names the name and the state (no "first choice" — it was false for a 2nd/3rd name)', () => {
    for (const policy of [formation, change]) {
      const c = approvalCopy(policy, { name: 'Acme Holdings', state: 'Florida', nameIndex: 1 })
      expect(c.title).toBe('Acme Holdings LLC')
      expect(c.message).toContain('Acme Holdings LLC')
      expect(c.message).toContain('Florida')
      expect(c.message).not.toMatch(/first choice/i)
      expect(c.message_it).toContain('Acme Holdings LLC')
      expect(c.message_it).not.toMatch(/prima scelta/i)
      expect(c.options.name_check).toEqual({ kind: 'approval', name_index: 1, name: 'Acme Holdings' })
    }
  })

  it('does not double an LLC suffix', () => {
    expect(displayNameFor('Acme LLC')).toBe('Acme LLC')
    expect(displayNameFor('Acme')).toBe('Acme LLC')
  })

  it('Formation asks for 3 new names with the OLD marker (comma split, cap unchanged)', () => {
    const c = newNamesCopy(formation, { reason: 'none_available' })
    expect(c.title).toBe('New LLC Names Needed')
    expect(c.message).toContain('propose 3 new LLC names')
    expect(c.options.name_check).toEqual({ kind: 'new_names' })
    const r = newNamesCopy(formation, { reason: 'sos_rejected', rejectedName: 'Zed LLC' })
    expect(r.message).toContain('"Zed LLC" was rejected by the Secretary of State')
  })

  it('Company Change Name asks for ONE new name, one per line, in both languages', () => {
    const none = newNamesCopy(change, { reason: 'none_available' })
    expect(none.message).toMatch(/send us a new name/i)
    expect(none.message_it).toMatch(/nuovo nome/i)
    expect(none.options.name_check).toEqual({ kind: 'new_names', split: 'lines', max: 1 })
    const rej = newNamesCopy(change, { reason: 'sos_rejected', rejectedName: 'Zed LLC' })
    expect(rej.message).toContain('"Zed LLC" was rejected by the Secretary of State')
    expect(rej.message_it).toContain('"Zed LLC"')
  })

  it('only a name change has a first ask, for up to 3 names, one per line', () => {
    expect(firstNamesCopy(formation)).toBeNull()
    const f = firstNamesCopy(change)!
    expect(f.message).toContain('up to 3 names')
    expect(f.message_it).toContain('fino a 3 nomi')
    expect(f.options.name_check).toEqual({ kind: 'new_names', split: 'lines', max: 3 })
    expect(f.options.required).toBe(true)
  })

  it('the chat note says what happened in the client\'s language', () => {
    const base = { displayName: 'Acme LLC', state: 'Florida' }
    expect(proposalChatNote(change, { ...base, language: 'en' })).toContain('We checked Acme LLC')
    expect(proposalChatNote(change, { ...base, language: 'it' })).toContain('Abbiamo verificato Acme LLC')
    expect(proposalChatNote(formation, { ...base, language: 'en' })).toContain('We checked your LLC names and Acme LLC is available in Florida')
  })
})
