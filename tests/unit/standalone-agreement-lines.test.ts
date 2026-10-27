import { describe, it, expect } from 'vitest'
import { selectedStandaloneAgreements, planAgreements, agreementCoverageGap, agreementCoverageWarnings } from '@/lib/offers/standalone-agreement-lines'

const line = (name: string, contract_type?: string, extra: Record<string, unknown> = {}) => ({ name, price: '$100', contract_type, ...extra })
const TAX = line('Tax Return', 'tax_return')
const CALL = line('Consulting Call', 'consulting_call')
const SHIP = line('Shipping', 'shipping')
const names = (r: { line: { name: string } }[]) => r.map((x) => x.line.name)
const types = (r: { type: string }[]) => r.map((x) => x.type)

describe('selectedStandaloneAgreements — one agreement per BOUGHT line', () => {
  it('a one-service offer has one entry; several are returned in offer order', () => {
    expect(types(selectedStandaloneAgreements({ services: [TAX] }, 'tax_return'))).toEqual(['tax_return'])
    expect(types(selectedStandaloneAgreements({ services: [TAX, CALL, SHIP] }, 'tax_return'))).toEqual(['tax_return', 'consulting_call', 'shipping'])
  })

  it('two lines of the same type are two agreements — both are billed (e.g. two tax years)', () => {
    const r = selectedStandaloneAgreements({ services: [line('Tax Return 2024', 'tax_return'), line('Tax Return 2025', 'tax_return'), CALL] }, 'tax_return')
    expect(names(r)).toEqual(['Tax Return 2024', 'Tax Return 2025', 'Consulting Call'])
  })

  it('lines typed formation / onboarding / unknown are not agreements here', () => {
    const r = selectedStandaloneAgreements({ services: [CALL, line('Company Formation', 'formation'), line('Client Onboarding', 'onboarding'), line('Mystery', 'zz_unknown')] }, 'consulting_call')
    expect(types(r)).toEqual(['consulting_call'])
  })

  it('an optional line counts only when TICKED (billing: no stored selection = required services only)', () => {
    const services = [TAX, line('Shipping', 'shipping', { optional: true }), line('Notary', 'public_notary', { optional: true })]
    expect(types(selectedStandaloneAgreements({ services, selected_services: ['Notary'] }, 'tax_return'))).toEqual(['tax_return', 'public_notary'])
    expect(types(selectedStandaloneAgreements({ services, selected_services: [] }, 'tax_return'))).toEqual(['tax_return'])
    expect(types(selectedStandaloneAgreements({ services }, 'tax_return'))).toEqual(['tax_return'])
  })

  it('the staff warning assumes optional lines are bought when nothing is stored yet', () => {
    const services = [TAX, line('Shipping', 'shipping', { optional: true })]
    expect(types(selectedStandaloneAgreements({ services }, 'tax_return', { assumeOptionalBought: true }))).toEqual(['tax_return', 'shipping'])
    expect(types(selectedStandaloneAgreements({ services, selected_services: ['Tax Return'] }, 'tax_return', { assumeOptionalBought: true }))).toEqual(['tax_return'])
  })

  it('a declined optional line is out even when it is the offer\'s own type', () => {
    const services = [{ ...TAX, optional: true }, CALL, SHIP]
    expect(types(selectedStandaloneAgreements({ services, selected_services: ['Consulting Call', 'Shipping'] }, 'tax_return'))).toEqual(['consulting_call', 'shipping'])
  })

  describe('a line with NO type of its own (documented: it belongs to the offer\'s own contract)', () => {
    it('the first untyped line is the offer\'s own agreement when no line carries the offer\'s type — in either position', () => {
      const untyped = line('Tax Return 2025')
      const a = selectedStandaloneAgreements({ services: [untyped, CALL] }, 'tax_return')
      expect(a.map((x) => [x.type, x.line.name])).toEqual([['tax_return', 'Tax Return 2025'], ['consulting_call', 'Consulting Call']])
      const b = selectedStandaloneAgreements({ services: [CALL, untyped] }, 'tax_return')
      expect(b.map((x) => [x.type, x.line.name])).toEqual([['consulting_call', 'Consulting Call'], ['tax_return', 'Tax Return 2025']])
    })
    it('only ONE untyped line is taken; the rest have no agreement', () => {
      const r = selectedStandaloneAgreements({ services: [line('Tax Return'), line('Extra Thing')] }, 'tax_return')
      expect(names(r)).toEqual(['Tax Return'])
    })
    it('not taken at all when a line already carries the offer\'s own type', () => {
      const r = selectedStandaloneAgreements({ services: [TAX, line('Extra Thing')] }, 'tax_return')
      expect(names(r)).toEqual(['Tax Return'])
    })
    it('without an offer type nothing untyped is ever an agreement', () => {
      expect(selectedStandaloneAgreements({ services: [line('Misc'), CALL] })).toHaveLength(1)
    })
  })

  it('tolerates missing, malformed or JSON-string services', () => {
    expect(selectedStandaloneAgreements({}, 'itin')).toEqual([])
    expect(selectedStandaloneAgreements({ services: null }, 'itin')).toEqual([])
    expect(types(selectedStandaloneAgreements({ services: [null as never, SHIP] }, 'shipping'))).toEqual(['shipping'])
    expect(types(selectedStandaloneAgreements({ services: JSON.stringify([TAX, CALL]) }, 'tax_return'))).toEqual(['tax_return', 'consulting_call'])
    expect(selectedStandaloneAgreements({ services: 'not json' }, 'tax_return')).toEqual([])
  })
})

describe('planAgreements — what the page shows', () => {
  it('switch OFF: always the original single agreement — the offer\'s own type, else the first line, ticked or not', () => {
    const p = planAgreements({ services: [CALL, TAX] }, 'tax_return', false)
    expect(p.mode).toBe('single')
    expect(names(p.entries)).toEqual(['Tax Return'])
    expect(names(planAgreements({ services: [line('Misc'), CALL] }, 'tax_return', false).entries)).toEqual(['Misc'])
    const declined = { services: [{ ...TAX, optional: true }, CALL], selected_services: ['Consulting Call'] }
    expect(names(planAgreements(declined, 'tax_return', false).entries)).toEqual(['Tax Return'])
  })

  it('switch ON, 2+ bought services: multi, one entry per line', () => {
    const p = planAgreements({ services: [TAX, CALL, SHIP] }, 'tax_return', true)
    expect(p.mode).toBe('multi')
    expect(types(p.entries)).toEqual(['tax_return', 'consulting_call', 'shipping'])
  })

  it('switch ON, one service: single', () => {
    const p = planAgreements({ services: [TAX] }, 'tax_return', true)
    expect(p.mode).toBe('single')
    expect(names(p.entries)).toEqual(['Tax Return'])
    expect(names(planAgreements({ services: [line('Misc'), CALL] }, 'consulting_call', true).entries)).toEqual(['Consulting Call'])
  })

  it('switch ON, the client declined the offer\'s own type and kept one other: that one is shown', () => {
    const o = { services: [{ ...TAX, optional: true }, line('ITIN', 'itin')], selected_services: ['ITIN'] }
    const p = planAgreements(o, 'tax_return', true)
    expect(p.mode).toBe('single')
    expect(types(p.entries)).toEqual(['itin'])
  })

  it('switch ON, UNTYPED offer-type line + a typed add-on (the MCP shape): both are shown, each with ITS OWN wording', () => {
    for (const services of [[line('Tax Return 2025'), CALL], [CALL, line('Tax Return 2025')]]) {
      const p = planAgreements({ services }, 'tax_return', true)
      expect(p.mode).toBe('multi')
      expect(p.entries.map((e) => [e.type, e.line.name]).sort()).toEqual([['consulting_call', 'Consulting Call'], ['tax_return', 'Tax Return 2025']])
    }
  })

  it('switch ON, only untyped lines: the original single agreement (never invents one)', () => {
    const p = planAgreements({ services: [line('Misc A'), line('Misc B')] }, 'tax_return', true)
    expect(p.mode).toBe('single')
    expect(names(p.entries)).toEqual(['Misc A'])
  })

  it('no lines at all: nothing to show', () => {
    expect(planAgreements({}, 'tax_return', true).entries).toEqual([])
    expect(planAgreements({}, 'tax_return', false).entries).toEqual([])
  })
})

describe('agreementCoverageGap + warnings — a billed service with no agreement in the contract', () => {
  it('nothing to say for a one-service offer or when every billed line is covered', () => {
    expect(agreementCoverageGap({ services: [TAX] }, 'tax_return', false)).toEqual({ hiddenBySwitch: [], withoutContract: [] })
    expect(agreementCoverageGap({ services: [TAX, CALL] }, 'tax_return', true)).toEqual({ hiddenBySwitch: [], withoutContract: [] })
  })

  it('switch OFF: the second typed service is not in the contract; the message names the switch', () => {
    const gap = agreementCoverageGap({ services: [TAX, CALL] }, 'tax_return', false)
    expect(gap.hiddenBySwitch).toEqual(['Consulting Call'])
    const w = agreementCoverageWarnings(gap)
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('"Consulting Call" is on this offer')
    expect(w[0]).toContain('is OFF')
    expect(w[0]).toContain("main service's agreement")
    // the switch stays OFF until the whole project is tested (Antonio, 2026-10-26): the message must never tell staff to turn it on
    expect(w[0]).not.toMatch(/turn it on/i)
    expect(w[0]).toContain('in its own offer')
  })

  it('switch ON never blames the switch: a typed service is always covered, an untyped one is called out as having no contract', () => {
    const gap = agreementCoverageGap({ services: [line('Tax Return 2025'), CALL, line('Extra Thing')] }, 'tax_return', true)
    expect(gap.hiddenBySwitch).toEqual([])
    expect(gap.withoutContract).toEqual(['Extra Thing'])
    expect(agreementCoverageWarnings(gap).join(' ')).not.toContain('is OFF')
  })

  it('a billed line with no contract of its own is called out whatever the switch says', () => {
    for (const on of [true, false]) {
      const gap = agreementCoverageGap({ services: [TAX, line('Extra Thing')] }, 'tax_return', on)
      expect(gap.withoutContract).toEqual(['Extra Thing'])
      expect(agreementCoverageWarnings(gap)[0]).toContain('has no contract of its own')
    }
  })

  it('uses the money engine\'s rules for what is billed: free, included and recurring lines are not flagged; "$500 / year" is recurring only per the engine', () => {
    const free = agreementCoverageGap({ services: [TAX, line('Gift', undefined, { price: '$0' }), line('Bundle', undefined, { price: 'Included' }), line('Inclusa', undefined, { price: '$300 inclusa' }), line('Renewal', undefined, { price: '$500/year' })] }, 'tax_return', true)
    expect(free).toEqual({ hiddenBySwitch: [], withoutContract: [] })
    // the engine does NOT treat "$500 / year" (space before the slash... after) as recurring, so it is billed
    expect(agreementCoverageGap({ services: [TAX, line('Spaced', undefined, { price: '$500 / year' })] }, 'tax_return', true).withoutContract).toEqual(['Spaced'])
  })

  it('an optional line is assumed bought at creation (nothing is ticked yet)', () => {
    const gap = agreementCoverageGap({ services: [TAX, line('ITIN Add-on', undefined, { optional: true })] }, 'tax_return', true)
    expect(gap.withoutContract).toEqual(['ITIN Add-on'])
  })

  it('offers whose main type is not a short contract are not judged', () => {
    expect(agreementCoverageGap({ services: [line('Company Formation', 'formation'), line('Extra')] }, 'formation', true)).toEqual({ hiddenBySwitch: [], withoutContract: [] })
    expect(agreementCoverageGap({ services: [TAX] }, null, true)).toEqual({ hiddenBySwitch: [], withoutContract: [] })
  })

  it('reads JSON-string services (MCP) like the pages do', () => {
    expect(agreementCoverageGap({ services: JSON.stringify([TAX, CALL]) }, 'tax_return', false).hiddenBySwitch).toEqual(['Consulting Call'])
  })

  it('several lines are listed in one grammatical sentence', () => {
    const w = agreementCoverageWarnings({ hiddenBySwitch: ['A', 'B'], withoutContract: ['C', 'D'] })
    expect(w[0]).toContain('"A", "B" are on this offer')
    expect(w[1]).toContain('"C", "D" are billed but have no contract of their own')
    expect(w[1]).toContain('no agreement for them')
  })
})
