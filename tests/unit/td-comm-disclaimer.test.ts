import { describe, it, expect } from 'vitest'
import {
  DEFAULT_DISCLAIMER_EN,
  DEFAULT_DISCLAIMER_IT,
  resolveDisclaimerText,
  disclaimerVersion,
  currentDisclaimerVersion,
  canRevealConcept,
  canApproveConcept,
} from '@/lib/td-communication/disclaimer'

describe('resolveDisclaimerText', () => {
  it('returns the Settings value when non-blank', () => {
    const settings = { disclaimer_en: 'Custom EN terms', disclaimer_it: 'Termini IT personalizzati' }
    expect(resolveDisclaimerText(settings, 'en')).toBe('Custom EN terms')
    expect(resolveDisclaimerText(settings, 'it')).toBe('Termini IT personalizzati')
  })

  it('falls back to the per-locale default when blank/whitespace', () => {
    expect(resolveDisclaimerText({ disclaimer_en: '', disclaimer_it: '   ' }, 'en')).toBe(DEFAULT_DISCLAIMER_EN)
    expect(resolveDisclaimerText({ disclaimer_en: '', disclaimer_it: '' }, 'it')).toBe(DEFAULT_DISCLAIMER_IT)
  })

  it('an Italian client never falls back to English terms', () => {
    // IT blank but EN set → still returns the IT default, not the EN value.
    const out = resolveDisclaimerText({ disclaimer_en: 'EN only', disclaimer_it: '' }, 'it')
    expect(out).toBe(DEFAULT_DISCLAIMER_IT)
    expect(out).not.toBe('EN only')
  })

  it('handles null/undefined settings', () => {
    expect(resolveDisclaimerText(null, 'en')).toBe(DEFAULT_DISCLAIMER_EN)
    expect(resolveDisclaimerText(undefined, 'it')).toBe(DEFAULT_DISCLAIMER_IT)
  })

  it('the default text carries the $10,000 penalty clause', () => {
    expect(DEFAULT_DISCLAIMER_EN).toContain('$10,000')
    expect(DEFAULT_DISCLAIMER_IT).toContain('10.000')
  })
})

describe('disclaimerVersion', () => {
  it('is deterministic for the same text', () => {
    expect(disclaimerVersion('a', 'b')).toBe(disclaimerVersion('a', 'b'))
  })

  it('changes when EN or IT text changes', () => {
    const base = disclaimerVersion('en', 'it')
    expect(disclaimerVersion('en2', 'it')).not.toBe(base)
    expect(disclaimerVersion('en', 'it2')).not.toBe(base)
  })

  it('has the v1- prefix and a short hash', () => {
    const v = disclaimerVersion('en', 'it')
    expect(v).toMatch(/^v1-[0-9a-f]{10}$/)
  })

  it('does not collide on swapped EN/IT (order matters)', () => {
    expect(disclaimerVersion('x', 'y')).not.toBe(disclaimerVersion('y', 'x'))
  })
})

describe('currentDisclaimerVersion', () => {
  it('equals the version of the resolved default text when Settings are blank', () => {
    const fromBlank = currentDisclaimerVersion({ disclaimer_en: '', disclaimer_it: '' })
    const fromDefaults = disclaimerVersion(DEFAULT_DISCLAIMER_EN, DEFAULT_DISCLAIMER_IT)
    expect(fromBlank).toBe(fromDefaults)
  })

  it('changes when an admin edits the terms', () => {
    const before = currentDisclaimerVersion({ disclaimer_en: '', disclaimer_it: '' })
    const after = currentDisclaimerVersion({ disclaimer_en: 'New terms', disclaimer_it: '' })
    expect(after).not.toBe(before)
  })
})

describe('canRevealConcept', () => {
  it('is true only for concept_ready and approved', () => {
    expect(canRevealConcept('concept_ready')).toBe(true)
    expect(canRevealConcept('approved')).toBe(true)
  })
  it('is false for every other status', () => {
    for (const s of ['enrolled', 'form_submitted', 'in_progress', 'revision', 'delivered', 'cancelled', 'bogus']) {
      expect(canRevealConcept(s)).toBe(false)
    }
  })
})

describe('canApproveConcept', () => {
  it('is true only from concept_ready', () => {
    expect(canApproveConcept('concept_ready')).toBe(true)
  })
  it('is false for approved (already approved → no-op) and all others', () => {
    for (const s of ['approved', 'enrolled', 'form_submitted', 'in_progress', 'revision', 'delivered', 'cancelled']) {
      expect(canApproveConcept(s)).toBe(false)
    }
  })
})
