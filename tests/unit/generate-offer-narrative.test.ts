import { describe, it, expect } from 'vitest'
import { validateNarrative, validateNarrativeChanges, renderCallForOffer, normalizeEntityType, NARRATIVE_KEYS, type NarrativeResponse } from '@/lib/offer-narrative'
import {
  buildRefineSystemPrompt,
  renderServiceLines,
  FALLBACK_BUSINESS_RULES,
  resolveBusinessRules,
  offerIncludesManagement,
} from '@/lib/offers/narrative-business-rules'

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

describe('normalizeEntityType', () => {
  it('maps the dialog short codes to human labels', () => {
    expect(normalizeEntityType('SMLLC')).toBe('Single-Member LLC')
    expect(normalizeEntityType('MMLLC')).toBe('Multi-Member LLC')
    expect(normalizeEntityType('Corp')).toBe('Corporation')
  })

  it('maps the full labels stored on the offer record', () => {
    expect(normalizeEntityType('Single Member LLC')).toBe('Single-Member LLC')
    expect(normalizeEntityType('Multi Member LLC')).toBe('Multi-Member LLC')
    expect(normalizeEntityType('Corporation')).toBe('Corporation')
  })

  it('is case- and whitespace-insensitive', () => {
    expect(normalizeEntityType('  smllc ')).toBe('Single-Member LLC')
    expect(normalizeEntityType('multi member llc')).toBe('Multi-Member LLC')
  })

  it('returns empty string for missing/unknown so the prompt stays generic', () => {
    expect(normalizeEntityType('')).toBe('')
    expect(normalizeEntityType(null)).toBe('')
    expect(normalizeEntityType(undefined)).toBe('')
    expect(normalizeEntityType('LLP')).toBe('')
  })
})

describe('renderServiceLines', () => {
  it('renders name + catalog description as one line', () => {
    expect(renderServiceLines([{ name: 'Onboarding', description: 'TD takes over management of an existing LLC.' }]))
      .toEqual(['Onboarding — TD takes over management of an existing LLC.'])
  })

  it('renders just the name when there is no description', () => {
    expect(renderServiceLines([{ name: 'Onboarding', description: null }])).toEqual(['Onboarding'])
    expect(renderServiceLines([{ name: 'Onboarding' }])).toEqual(['Onboarding'])
  })

  it('accepts bare-string services for backward compatibility', () => {
    expect(renderServiceLines(['Onboarding', 'EIN Application'])).toEqual(['Onboarding', 'EIN Application'])
  })

  it('drops blank / nameless entries', () => {
    expect(renderServiceLines(['', { name: '' }, { description: 'orphan' } as { name?: string; description?: string }, 'Real']))
      .toEqual(['Real'])
  })
})

describe('FALLBACK_BUSINESS_RULES (minimal fail-safe floor)', () => {
  it('forbids bookkeeping and keeps tax wording generic', () => {
    expect(FALLBACK_BUSINESS_RULES.toLowerCase()).toContain('does not offer')
    expect(FALLBACK_BUSINESS_RULES.toLowerCase()).toContain('bookkeeping')
    expect(FALLBACK_BUSINESS_RULES.toLowerCase()).toMatch(/stay general|generic/i)
  })

  it('is a floor, NOT a mirror — it does not duplicate the rich KB content', () => {
    // The rich per-entity filing + portal detail lives ONLY in the editable KB
    // article, so the fallback can never drift from it. Guard that here.
    expect(FALLBACK_BUSINESS_RULES).not.toContain('5472')
    expect(FALLBACK_BUSINESS_RULES).not.toContain('1065')
    expect(FALLBACK_BUSINESS_RULES.toLowerCase()).not.toContain('portal chat')
  })
})

describe('resolveBusinessRules', () => {
  it('uses the KB article content when present', () => {
    const r = resolveBusinessRules({ content: 'REAL RULES FROM KB' })
    expect(r).toEqual({ rules: 'REAL RULES FROM KB', source: 'kb' })
  })

  it('falls back to the floor and flags a missing article', () => {
    expect(resolveBusinessRules(null)).toEqual({ rules: FALLBACK_BUSINESS_RULES, source: 'fallback_missing' })
    expect(resolveBusinessRules({ content: '' }).source).toBe('fallback_missing')
    expect(resolveBusinessRules({ content: '   ' }).source).toBe('fallback_missing')
    expect(resolveBusinessRules({ content: null }).source).toBe('fallback_missing')
  })
})

describe('offerIncludesManagement', () => {
  it('is true only for management contract types', () => {
    expect(offerIncludesManagement('formation')).toBe(true)
    expect(offerIncludesManagement('onboarding')).toBe(true)
    expect(offerIncludesManagement('renewal')).toBe(true)
  })
  it('is false for standalone / unknown contract types', () => {
    expect(offerIncludesManagement('itin')).toBe(false)
    expect(offerIncludesManagement('tax_return')).toBe(false)
    expect(offerIncludesManagement('')).toBe(false)
    expect(offerIncludesManagement(null)).toBe(false)
    expect(offerIncludesManagement(undefined)).toBe(false)
  })
})

describe('validateNarrativeChanges (refine — only changed sections)', () => {
  it('accepts a partial change with a note and drops unknown keys', () => {
    const r = validateNarrativeChanges({ note: 'Shortened intro.', changes: { intro_en: 'Short.', bogus: 1 } }, 'en')
    expect(r.valid).toBe(true)
    if (r.valid) {
      expect(r.note).toBe('Shortened intro.')
      expect(r.changes).toEqual({ intro_en: 'Short.' })
    }
  })

  it('accepts an empty changes object (a no-op refine)', () => {
    const r = validateNarrativeChanges({ note: 'Nothing to change.', changes: {} }, 'en')
    expect(r.valid).toBe(true)
    if (r.valid) expect(r.changes).toEqual({})
  })

  it('validates section shapes', () => {
    const good = validateNarrativeChanges({ changes: { strategy: [{ step_number: 1, title: 'T', description: 'D' }] } }, 'en')
    expect(good.valid).toBe(true)
    const bad = validateNarrativeChanges({ changes: { strategy: [{ title: 'no step number' }] } }, 'en')
    expect(bad.valid).toBe(false)
    const badActions = validateNarrativeChanges({ changes: { immediate_actions: [{ title: 'x' }] } }, 'en')
    expect(badActions.valid).toBe(false)
  })

  it('enforces the single-language intro rule', () => {
    expect(validateNarrativeChanges({ changes: { intro_it: 'Ciao' } }, 'en').valid).toBe(false)
    expect(validateNarrativeChanges({ changes: { intro_en: 'Hi' } }, 'it').valid).toBe(false)
    expect(validateNarrativeChanges({ changes: { intro_it: 'Ciao' } }, 'it').valid).toBe(true)
  })

  it('rejects non-object input', () => {
    expect(validateNarrativeChanges(null, 'en').valid).toBe(false)
    expect(validateNarrativeChanges('nope', 'en').valid).toBe(false)
  })
})

describe('buildRefineSystemPrompt (faithful writing assistant)', () => {
  it('trusts the author and keeps the changed-only output contract', () => {
    const p = buildRefineSystemPrompt('en', 'RULES BLOCK CONTENT', '- Banking: open a US business bank account')
    expect(p).toContain('ONLY the sections you actually changed')
    expect(p.toLowerCase()).toContain('do not refuse')
    // business rules + service menu are injected as REFERENCE, not restrictions
    expect(p).toContain('RULES BLOCK CONTENT')
    expect(p).toContain('- Banking: open a US business bank account')
  })
  it('does not gate on management or lecture about scope', () => {
    const p = buildRefineSystemPrompt('it', 'RULES')
    expect(p).not.toContain('does NOT include ongoing management')
    expect(p.toLowerCase()).not.toContain('never add bookkeeping')
    expect(p).toContain('Italian')
  })
})

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

describe('validateNarrative — single-language mode (2026-05-07)', () => {
  it("accepts intro_en only when language='en'", () => {
    const n = validNarrative()
    n.intro_it = ''
    const result = validateNarrative(n, 'en')
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.result.intro_en).toContain('Dear John')
      expect(result.result.intro_it).toBe('')
    }
  })

  it("rejects empty intro_en when language='en'", () => {
    const n = validNarrative()
    n.intro_en = ''
    n.intro_it = ''
    const result = validateNarrative(n, 'en')
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('intro_en')
  })

  it("rejects non-empty intro_it when language='en'", () => {
    const n = validNarrative()
    // intro_it left populated
    const result = validateNarrative(n, 'en')
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toMatch(/intro_it must be empty/)
  })

  it("accepts intro_it only when language='it'", () => {
    const n = validNarrative()
    n.intro_en = ''
    const result = validateNarrative(n, 'it')
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.result.intro_it).toContain('Caro John')
      expect(result.result.intro_en).toBe('')
    }
  })

  it("rejects non-empty intro_en when language='it'", () => {
    const n = validNarrative()
    // intro_en left populated
    const result = validateNarrative(n, 'it')
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toMatch(/intro_en must be empty/)
  })

  it('accepts missing intro_it (undefined) in en mode', () => {
    const n = validNarrative() as unknown as Record<string, unknown>
    delete n.intro_it
    const result = validateNarrative(n, 'en')
    expect(result.valid).toBe(true)
  })

  it('preserves legacy strict-both behavior when language is undefined', () => {
    const n = validNarrative()
    n.intro_it = ''
    const result = validateNarrative(n) // no language → both required
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('intro_it')
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

// ── renderCallForOffer (transcript context for the narrative generator) ──

describe('renderCallForOffer', () => {
  it('renders notes + transcript turns with a header', () => {
    const out = renderCallForOffer({
      meeting_name: 'Intake — Acme LLC',
      created_at: '2026-06-19T10:00:00Z',
      notes: 'Client sells SaaS in the EU, wants a US LLC for Stripe.',
      transcript: [
        { speaker: 'Antonio', text: 'What do you sell?' },
        { speaker: 'Client', text: 'SaaS subscriptions to EU businesses.' },
      ],
    })
    expect(out).toContain('Call: Intake — Acme LLC')
    expect(out).toContain('Client sells SaaS')
    expect(out).toContain('[Antonio]: What do you sell?')
    expect(out).toContain('[Client]: SaaS subscriptions to EU businesses.')
    expect(out).toContain('2 turns')
  })

  it('handles the alternate {name, content} turn shape', () => {
    const out = renderCallForOffer({
      meeting_name: 'Call',
      transcript: [{ name: 'Luca', content: 'Hello there' }],
    })
    expect(out).toContain('[Luca]: Hello there')
  })

  it('works notes-only (no transcript) and transcript-only (no notes)', () => {
    expect(renderCallForOffer({ meeting_name: 'C', notes: 'just notes' })).toContain('just notes')
    const tOnly = renderCallForOffer({ transcript: [{ speaker: 'A', text: 'hi' }] })
    expect(tOnly).toContain('[A]: hi')
    expect(tOnly).toContain('Client intake call') // default header when no meeting_name
  })

  it('returns "" when there is nothing useful (null, empty, blank turns)', () => {
    expect(renderCallForOffer(null)).toBe('')
    expect(renderCallForOffer(undefined)).toBe('')
    expect(renderCallForOffer({ meeting_name: 'C', notes: '   ', transcript: [] })).toBe('')
    expect(renderCallForOffer({ transcript: [{ speaker: 'A', text: '' }] })).toBe('')
  })

  it('caps very long transcripts', () => {
    const turns = Array.from({ length: 5000 }, (_, i) => ({ speaker: 'X', text: `turn number ${i} with some words` }))
    const out = renderCallForOffer({ meeting_name: 'Long', transcript: turns }, 2000)
    expect(out.length).toBeLessThanOrEqual(2000 + 30)
    expect(out).toContain('(transcript truncated)')
  })
})
