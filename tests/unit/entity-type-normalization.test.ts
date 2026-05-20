import { describe, it, expect } from 'vitest'
import { normalizeEntityType } from '@/lib/portal/entity-type'
import { getWizardConfig } from '@/components/portal/wizard/wizard-configs'

describe('normalizeEntityType', () => {
  it('maps the stored "Multi Member LLC" (space) to MMLLC', () => {
    expect(normalizeEntityType('Multi Member LLC')).toBe('MMLLC')
  })

  it('maps the hyphenated "Multi-Member LLC" to MMLLC', () => {
    expect(normalizeEntityType('Multi-Member LLC')).toBe('MMLLC')
  })

  it('keeps the code form MMLLC', () => {
    expect(normalizeEntityType('MMLLC')).toBe('MMLLC')
  })

  it('maps "Single Member LLC" (space) to SMLLC', () => {
    expect(normalizeEntityType('Single Member LLC')).toBe('SMLLC')
  })

  it('keeps the code form SMLLC', () => {
    expect(normalizeEntityType('SMLLC')).toBe('SMLLC')
  })

  it('is case-insensitive', () => {
    expect(normalizeEntityType('multi member llc')).toBe('MMLLC')
  })

  it('defaults null/undefined/empty to SMLLC', () => {
    expect(normalizeEntityType(null)).toBe('SMLLC')
    expect(normalizeEntityType(undefined)).toBe('SMLLC')
    expect(normalizeEntityType('')).toBe('SMLLC')
  })

  it('leaves non-LLC types unchanged (Corp handling stays intact)', () => {
    expect(normalizeEntityType('C-Corp Elected')).toBe('C-Corp Elected')
  })
})

describe('formation wizard members step (regression: Adam Mihaly could not add Péter)', () => {
  it('renders the members step for a "Multi Member LLC" formation after normalization', () => {
    const entityType = normalizeEntityType('Multi Member LLC')
    const { steps } = getWizardConfig('formation', entityType)
    expect(steps.some(s => s.id === 'members')).toBe(true)
  })

  it('does NOT render the members step for a single-member formation', () => {
    const entityType = normalizeEntityType('Single Member LLC')
    const { steps } = getWizardConfig('formation', entityType)
    expect(steps.some(s => s.id === 'members')).toBe(false)
  })

  it('the raw stored value WITHOUT normalization would have hidden the members step (proves the bug)', () => {
    // Passing the raw DB value straight through (the old behavior) yields no members step.
    const { steps } = getWizardConfig('formation', 'Multi Member LLC')
    expect(steps.some(s => s.id === 'members')).toBe(false)
  })
})
