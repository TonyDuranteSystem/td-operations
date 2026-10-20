/**
 * Company Change Name as a client-facing flow (dev job bb64c417, track A): the client portal page and
 * Overview card exist for it (before this, every decision-request bell linked to /portal/flows/{sd},
 * which 404ed for the type), the step journey is the rich one, and only the state's stamped
 * document is client-visible by default.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FLOW_TYPES, CONTACT_FLOW_TYPES, ALL_FLOW_TYPES, JOURNEY_FLOW_TYPES } from '@/lib/flows/resolve-flows'
import { isClientSafeFlowDoc } from '@/lib/flows/flow-doc-visibility'
import { CHANGE_NAME_STAGES, CHANGE_NAME_STAGE_ORDER } from '@/lib/flows/change-name-stages'

describe('flow types', () => {
  it('a name change is an account-scoped flow type with a portal page', () => {
    expect(FLOW_TYPES).toContain('Company Change Name')
    expect(ALL_FLOW_TYPES).toContain('Company Change Name')
  })

  it('it is NOT a contact-scoped flow (those are resolved by contact with account_id NULL)', () => {
    expect(CONTACT_FLOW_TYPES).not.toContain('Company Change Name')
  })

  it('the rich per-step journey covers the contact flows and the name change, and nothing else', () => {
    expect([...JOURNEY_FLOW_TYPES].sort()).toEqual(['Company Change Name', 'Company Formation', 'ITIN'])
  })

  it('the existing flow types are all still there (Tax Return, annual report, RA renewal, CMRA, ITIN, Formation)', () => {
    for (const t of ['Tax Return', 'State Annual Report', 'State RA Renewal', 'CMRA Mailing Address', 'ITIN', 'Company Formation']) {
      expect(ALL_FLOW_TYPES).toContain(t)
    }
  })

  it('the portal flow page uses the journey list, not the contact list, to choose the rich journey', () => {
    const page = readFileSync(join(process.cwd(), 'app/portal/flows/[id]/page.tsx'), 'utf8')
    expect(page).toContain('JOURNEY_FLOW_TYPES')
    expect(page).not.toMatch(/CONTACT_FLOW_TYPES as readonly string\[\]\)\.includes\(sd\.service_type\)/)
  })

  it('the staff flow chips have an icon for the type (the Record is exhaustive at build time too)', () => {
    const chips = readFileSync(join(process.cwd(), 'components/flows/flow-chips.tsx'), 'utf8')
    expect(chips).toContain("'Company Change Name': PenLine")
  })
})

describe('client-visible documents of a name change', () => {
  it('the state\'s stamped document (uploaded while waiting for the state) is visible', () => {
    expect(isClientSafeFlowDoc('Company Change Name', CHANGE_NAME_STAGES.wait, false)).toBe(true)
  })

  it('everything else staff uploads stays internal until published (fail-closed)', () => {
    for (const stage of [CHANGE_NAME_STAGES.collect, CHANGE_NAME_STAGES.check, CHANGE_NAME_STAGES.sign, CHANGE_NAME_STAGES.file, CHANGE_NAME_STAGES.records, CHANGE_NAME_STAGES.oa, CHANGE_NAME_STAGES.done, 'Some Unknown Stage', null]) {
      expect(isClientSafeFlowDoc('Company Change Name', stage, false)).toBe(false)
    }
  })

  it('an explicitly published document is always visible', () => {
    expect(isClientSafeFlowDoc('Company Change Name', CHANGE_NAME_STAGES.file, true)).toBe(true)
  })
})

describe('the stage list', () => {
  it('has the 8 stages in order, with the unchanged first stage name the live job already sits on', () => {
    expect(CHANGE_NAME_STAGE_ORDER).toHaveLength(8)
    expect(CHANGE_NAME_STAGE_ORDER[0]).toBe('Collect three company names')
    expect(CHANGE_NAME_STAGE_ORDER[7]).toBe('Completed')
    expect(new Set(CHANGE_NAME_STAGE_ORDER).size).toBe(8)
  })
})
