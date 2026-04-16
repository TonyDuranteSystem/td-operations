import { describe, it, expect } from 'vitest'
import { validateNarrative, NARRATIVE_KEYS, type NarrativeResponse } from '@/lib/offer-narrative'

function validNarrative(): NarrativeResponse {
  return {
    intro_en: 'Dear John, based on our conversation...',
    intro_it: 'Caro John, sulla base della nostra conversazione...',
    strategy: [
      { step_number: 1, title: 'LLC Formation', description: 'We will form your LLC in New Mexico.' },
      { step_number: 2, title: 'EIN Application', description: 'We will apply for your EIN with the IRS.' },
      { step_number: 3, title: 'Bank Account', description: 'We will set up a business bank account.' },
    ],
    next_steps: [
      { step_number: 1, title: 'Sign Contract', description: 'Review and sign the contract below.' },
      { step_number: 2, title: 'Complete Onboarding', description: 'Fill out the onboarding form with your details.' },
    ],
    future_developments: [
      { text: 'Tax return preparation services for next year.' },
      { text: 'ITIN application if needed for tax compliance.' },
    ],
    immediate_actions: [
      { title: 'Passport Copy', description: 'Please provide a clear copy of your passport.' },
      { title: 'Address Verification', description: 'Provide proof of your residential address.' },
    ],
  }
}

describe('validateNarrative', () => {
  it('accepts a valid narrative response', () => {
    const result = validateNarrative(validNarrative())
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.result.intro_en).toContain('Dear John')
      expect(result.result.strategy).toHaveLength(3)
    }
  })

  it('rejects null', () => {
    const result = validateNarrative(null)
    expect(result.valid).toBe(false)
  })

  it('rejects non-object', () => {
    const result = validateNarrative('string')
    expect(result.valid).toBe(false)
  })

  it('rejects empty intro_en', () => {
    const n = validNarrative()
    n.intro_en = ''
    const result = validateNarrative(n)
    expect(result.valid).toBe(false)
    if (!result.valid) expect((result as { valid: false; error: string }).error).toContain('intro_en')
  })

  it('rejects missing intro_it', () => {
    const n = validNarrative()
    ;(n as unknown as Record<string, unknown>).intro_it = 123
    const result = validateNarrative(n)
    expect(result.valid).toBe(false)
    if (!result.valid) expect((result as { valid: false; error: string }).error).toContain('intro_it')
  })

  it('rejects empty strategy array', () => {
    const n = validNarrative()
    n.strategy = []
    const result = validateNarrative(n)
    expect(result.valid).toBe(false)
    if (!result.valid) expect((result as { valid: false; error: string }).error).toContain('strategy')
  })

  it('rejects strategy items with missing fields', () => {
    const n = validNarrative()
    n.strategy = [{ step_number: 1, title: 'OK' } as any]
    const result = validateNarrative(n)
    expect(result.valid).toBe(false)
    if (!result.valid) expect((result as { valid: false; error: string }).error).toContain('strategy')
  })

  it('rejects empty next_steps array', () => {
    const n = validNarrative()
    n.next_steps = []
    const result = validateNarrative(n)
    expect(result.valid).toBe(false)
  })

  it('rejects empty future_developments array', () => {
    const n = validNarrative()
    n.future_developments = []
    const result = validateNarrative(n)
    expect(result.valid).toBe(false)
  })

  it('rejects future_developments items without text', () => {
    const n = validNarrative()
    n.future_developments = [{ text: 123 } as any]
    const result = validateNarrative(n)
    expect(result.valid).toBe(false)
  })

  it('rejects empty immediate_actions array', () => {
    const n = validNarrative()
    n.immediate_actions = []
    const result = validateNarrative(n)
    expect(result.valid).toBe(false)
  })

  it('rejects immediate_actions items without description', () => {
    const n = validNarrative()
    n.immediate_actions = [{ title: 'OK' } as any]
    const result = validateNarrative(n)
    expect(result.valid).toBe(false)
  })
})

describe('NARRATIVE_KEYS', () => {
  it('contains all 6 narrative field names', () => {
    expect(NARRATIVE_KEYS).toHaveLength(6)
    expect(NARRATIVE_KEYS).toContain('intro_en')
    expect(NARRATIVE_KEYS).toContain('intro_it')
    expect(NARRATIVE_KEYS).toContain('strategy')
    expect(NARRATIVE_KEYS).toContain('next_steps')
    expect(NARRATIVE_KEYS).toContain('future_developments')
    expect(NARRATIVE_KEYS).toContain('immediate_actions')
  })
})
