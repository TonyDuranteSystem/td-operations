import { describe, it, expect } from 'vitest'
import { validateNarrative, validateNarrativeChanges, renderCallForOffer, normalizeEntityType, NARRATIVE_KEYS, type NarrativeResponse } from '@/lib/offer-narrative'
import {
  buildRefineSystemPrompt,
  buildRefineUserPrompt,
  buildUserPrompt,
  renderServiceLines,
  FALLBACK_BUSINESS_RULES,
  resolveBusinessRules,
  offerIncludesManagement,
  canGroundFormationState,
  canGroundEntityType,
  extractJsonObject,
  reconstructAiNarrativeBaseline,
  detectOverwrittenHandEdits,
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

  it('tells the model to ground on a RELEVANT CALL CONTEXT block when one is given (2026-09-16)', () => {
    const p = buildRefineSystemPrompt('en', 'RULES')
    expect(p).toContain('RELEVANT CALL CONTEXT')
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

// ── Grounding gates (dev_task 2b6e5988 — the "South Dakota" hallucination) ──
// The generator once invented a formation state because it was never told the
// real one. These gates decide when the caller may assert a state/entity type
// as fact instead of leaving the writer either to guess or to be told nothing.

describe('canGroundFormationState', () => {
  it('true only when unambiguous (single option) AND the contract type is formation', () => {
    expect(canGroundFormationState({ contractType: 'formation', hasMultipleOptions: false })).toBe(true)
  })

  it('false when the offer has multiple options, even if contract type is formation', () => {
    expect(canGroundFormationState({ contractType: 'formation', hasMultipleOptions: true })).toBe(false)
  })

  it('false when contract type is not formation, even if unambiguous — the bug-hunter blocker', () => {
    // formationState can survive as stale dialog component state after a staffer
    // switches a formation offer's services to a different service type. Not
    // being multi-option is NOT enough on its own to assert a leftover state.
    expect(canGroundFormationState({ contractType: 'onboarding', hasMultipleOptions: false })).toBe(false)
    expect(canGroundFormationState({ contractType: 'itin', hasMultipleOptions: false })).toBe(false)
    expect(canGroundFormationState({ contractType: null, hasMultipleOptions: false })).toBe(false)
    expect(canGroundFormationState({ contractType: undefined, hasMultipleOptions: false })).toBe(false)
  })

  it('false when BOTH conditions fail', () => {
    expect(canGroundFormationState({ contractType: 'onboarding', hasMultipleOptions: true })).toBe(false)
  })
})

describe('canGroundEntityType', () => {
  it('true whenever unambiguous, regardless of contract type — unlike formation state', () => {
    expect(canGroundEntityType({ hasMultipleOptions: false })).toBe(true)
  })

  it('false when the offer has multiple options (they may disagree on entity type)', () => {
    expect(canGroundEntityType({ hasMultipleOptions: true })).toBe(false)
  })
})

describe('buildUserPrompt — formation-state grounding', () => {
  it('states the ONLY state when the caller passed one (already gated)', () => {
    const p = buildUserPrompt('Client', 'en', ['Formation'], '', 'formation', 'Single-Member LLC', 'WY')
    expect(p).toContain('STATE OF FORMATION: WY')
    expect(p).toContain('the ONLY state this offer forms in')
  })

  it('a formation offer with no state passed explicitly forbids naming one (never silently omitted)', () => {
    const p = buildUserPrompt('Client', 'en', ['Formation'], '', 'formation', 'Single-Member LLC')
    expect(p).toContain('STATE OF FORMATION: Not specified')
    expect(p).toContain('Do NOT name or imply any specific U.S. state')
  })

  it('a non-formation offer with no state gets no STATE OF FORMATION line at all', () => {
    const p = buildUserPrompt('Client', 'en', ['Onboarding'], '', 'onboarding', 'Single-Member LLC')
    expect(p).not.toContain('STATE OF FORMATION')
  })
})

describe('buildRefineUserPrompt — formation-state grounding + staleness note', () => {
  const baseOpts = {
    clientName: 'Client', contractType: 'formation', entityType: 'Single-Member LLC',
    serviceLines: ['Formation'], current: {}, instruction: 'shorten it',
  }

  it('states the ONLY state when grounded', () => {
    const p = buildRefineUserPrompt({ ...baseOpts, formationState: 'FL' })
    expect(p).toContain('STATE OF FORMATION: FL')
  })

  it('forbids naming a state when ungrounded but still a formation offer', () => {
    const p = buildRefineUserPrompt({ ...baseOpts, formationState: '' })
    expect(p).toContain('STATE OF FORMATION: Not specified')
  })

  it('omits the state line entirely for a non-formation contract type', () => {
    const p = buildRefineUserPrompt({ ...baseOpts, contractType: 'onboarding', formationState: '' })
    expect(p).not.toContain('STATE OF FORMATION')
  })

  it('includes the staleness note only when the caller passed one', () => {
    const withNote = buildRefineUserPrompt({ ...baseOpts, formationState: 'FL', staleGroundingNote: 'The state changed.' })
    expect(withNote).toContain('NOTE: The state changed.')
    const withoutNote = buildRefineUserPrompt({ ...baseOpts, formationState: 'FL' })
    expect(withoutNote).not.toContain('NOTE:')
  })

  it('includes the RELEVANT CALL CONTEXT block only when the caller passed one (2026-09-16)', () => {
    const withCall = buildRefineUserPrompt({ ...baseOpts, callContext: 'He asked for a Wyoming LLC on the call.' })
    expect(withCall).toContain('RELEVANT CALL CONTEXT')
    expect(withCall).toContain('He asked for a Wyoming LLC on the call.')
    const withoutCall = buildRefineUserPrompt({ ...baseOpts })
    expect(withoutCall).not.toContain('RELEVANT CALL CONTEXT')
  })

  it('can include both RELEVANT EMAIL and RELEVANT CALL CONTEXT at once', () => {
    const p = buildRefineUserPrompt({ ...baseOpts, emailContext: 'Email says Florida.', callContext: 'Call says Wyoming.' })
    expect(p).toContain('RELEVANT EMAIL')
    expect(p).toContain('Email says Florida.')
    expect(p).toContain('RELEVANT CALL CONTEXT')
    expect(p).toContain('Call says Wyoming.')
  })
})

describe('extractJsonObject', () => {
  it('parses a clean JSON object unchanged', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}')
  })

  it('strips a markdown code fence', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(extractJsonObject('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('recovers a JSON object wrapped in explanatory prose (live-observed failure mode)', () => {
    const raw = "I'll keep the Italian intro empty per the rules.\n\n{\"intro_en\": \"Hello.\"}\n\nLet me know if you'd like anything else."
    expect(extractJsonObject(raw)).toBe('{"intro_en": "Hello."}')
  })

  it('recovers a fenced object that also has prose before the fence', () => {
    const raw = "Here you go:\n```json\n{\"a\": {\"nested\": 1}}\n```"
    expect(JSON.parse(extractJsonObject(raw))).toEqual({ a: { nested: 1 } })
  })

  it('falls through to the fence-stripped text unchanged when no braces are found, so JSON.parse still fails loudly', () => {
    expect(extractJsonObject('sorry, I cannot do that')).toBe('sorry, I cannot do that')
  })

  it('handles nested objects — takes the outermost braces, not the first inner pair', () => {
    const raw = '{"outer": {"inner": "value"}}'
    expect(JSON.parse(extractJsonObject(raw))).toEqual({ outer: { inner: 'value' } })
  })
})

describe('reconstructAiNarrativeBaseline', () => {
  it('reads turn 1 (the full narrative at the top level, no "changes" wrapper)', () => {
    const turns = [
      { role: 'user', content: 'generate' },
      { role: 'assistant', content: JSON.stringify({ intro_en: 'Hello.', future_developments: [{ text: 'grow' }] }) },
    ]
    expect(reconstructAiNarrativeBaseline(turns)).toEqual({
      intro_en: 'Hello.',
      future_developments: [{ text: 'grow' }],
    })
  })

  it('overlays a later { note, changes } turn onto turn 1, keeping untouched fields', () => {
    const turns = [
      { role: 'assistant', content: JSON.stringify({ intro_en: 'Hello.', strategy: [{ step_number: 1, title: 'A', description: 'B' }] }) },
      { role: 'user', content: 'be more casual' },
      { role: 'assistant', content: JSON.stringify({ note: 'Warmed the tone.', changes: { intro_en: 'Hey there!' } }) },
    ]
    expect(reconstructAiNarrativeBaseline(turns)).toEqual({
      intro_en: 'Hey there!', // overlaid by turn 2
      strategy: [{ step_number: 1, title: 'A', description: 'B' }], // untouched, still from turn 1
    })
  })

  it('ignores user turns', () => {
    const turns = [{ role: 'user', content: JSON.stringify({ intro_en: 'should not appear' }) }]
    expect(reconstructAiNarrativeBaseline(turns)).toEqual({})
  })

  it('skips an unparseable assistant turn instead of throwing', () => {
    const turns = [
      { role: 'assistant', content: JSON.stringify({ intro_en: 'Hello.' }) },
      { role: 'assistant', content: 'sorry, I cannot do that' },
    ]
    expect(() => reconstructAiNarrativeBaseline(turns)).not.toThrow()
    expect(reconstructAiNarrativeBaseline(turns)).toEqual({ intro_en: 'Hello.' })
  })

  it('returns an empty baseline for no turns', () => {
    expect(reconstructAiNarrativeBaseline([])).toEqual({})
  })
})

describe('detectOverwrittenHandEdits', () => {
  const changedTurns = (baseline: Record<string, unknown>) => [
    { role: 'assistant' as const, content: JSON.stringify(baseline) },
  ]

  it('does not flag a field whose on-screen value still matches the AI baseline', () => {
    const baseline = reconstructAiNarrativeBaseline(changedTurns({ intro_en: 'Hello.' }))
    const result = detectOverwrittenHandEdits({ intro_en: 'Hello.' }, baseline, { intro_en: 'Hello, updated.' })
    expect(result).toEqual([])
  })

  it('flags a plain-text field (intro) whose hand-typed insertion does NOT survive in the new value', () => {
    const baseline = reconstructAiNarrativeBaseline(changedTurns({ intro_en: 'Hello there.' }))
    const result = detectOverwrittenHandEdits(
      { intro_en: 'Hello HAND-EDIT-MARKER there.' },
      baseline,
      { intro_en: 'Hi there, completely rewritten.' }, // the marker is gone — a real loss
    )
    expect(result).toEqual(['Introduction (English)'])
  })

  it('does NOT flag a plain-text field when the hand-typed insertion survives verbatim in the new value (live false-positive found 2026-09-16 re-testing this fix)', () => {
    // Reproduces the exact live scenario: a marker sentence typed mid-paragraph,
    // then a broad instruction that legitimately rewrites the surrounding text —
    // the model wove its correction around the hand-typed sentence and kept it
    // intact, so nothing was actually lost.
    const baseline = reconstructAiNarrativeBaseline(changedTurns({
      intro_en: 'Uxio Test LLC, it was great connecting with you on our recent call and learning about your plans to establish a new business presence through a Florida Multi-Member LLC.',
    }))
    const handEdited = 'Uxio Test LLC, it was great connecting with you on our recent call and learning about your plans to establish a new busiHAND-EDIT-MARKER-2: Antonio typed this himself, do not remove it. ess presence through a Florida Multi-Member LLC.'
    const newValue = 'Uxio Test LLC, it was great connecting with you on our recent call and learning about your plans to establish a new busiHAND-EDIT-MARKER-2: Antonio typed this himself, do not remove it. ess presence through a Florida Corporation.'
    const result = detectOverwrittenHandEdits({ intro_en: handEdited }, baseline, { intro_en: newValue })
    expect(result).toEqual([])
  })

  it('KNOWN LIMITATION, pinned not accidental: once a hand-edit survives one turn, a LATER turn can drop it undetected (live-verified 2026-09-16 re-testing the false-positive fix)', () => {
    // Turn 1: the AI's own output already contains the hand-typed marker
    // (the "preserved" case above) — from this point on it's indistinguishable
    // from AI-authored content, because nothing but the turn history is
    // available to reconstruct a baseline from.
    const baseline = reconstructAiNarrativeBaseline(changedTurns({
      intro_en: 'Uxio Test LLC, thanks for the call. HAND-EDIT-MARKER-3: Antonio typed this himself, do not remove it. Florida Corporation ahead.',
    }))
    // Turn 2: nothing was hand-edited AGAIN before sending — current equals
    // the baseline exactly — then the AI fully rewrites the intro and the
    // marker is genuinely gone. This SHOULD arguably be flagged but is not:
    // there is no "current differs from baseline" signal left to detect it.
    const current = {
      intro_en: 'Uxio Test LLC, thanks for the call. HAND-EDIT-MARKER-3: Antonio typed this himself, do not remove it. Florida Corporation ahead.',
    }
    const rewritten = 'Your Florida Corporation starts here — fast, clean, and fully handled.'
    const result = detectOverwrittenHandEdits(current, baseline, { intro_en: rewritten })
    expect(result).toEqual([]) // known gap, not a false claim of safety — see the function's own doc comment
  })

  it('never flags a field the AI is not changing this turn, even if it was hand-edited', () => {
    const baseline = reconstructAiNarrativeBaseline(changedTurns({ intro_en: 'Hello.', strategy: [] }))
    const result = detectOverwrittenHandEdits(
      { intro_en: 'Hello. HAND-EDIT-MARKER.', strategy: '[]' },
      baseline,
      { strategy: [{ step_number: 1, title: 'A', description: 'B' }] }, // only strategy is changing this turn — intro_en's hand-edit is not at risk
    )
    expect(result).toEqual([])
  })

  it('never flags a field with no prior AI baseline (nothing to compare against yet)', () => {
    const result = detectOverwrittenHandEdits({ intro_it: 'Ciao.' }, {}, { intro_it: 'Ciao, updated.' })
    expect(result).toEqual([])
  })

  it('flags a JSON array field whose item order changed (order is a real change here)', () => {
    const baseline = reconstructAiNarrativeBaseline(changedTurns({
      future_developments: [{ text: 'first' }, { text: 'second' }],
    }))
    const handEdited = JSON.stringify([{ text: 'second' }, { text: 'first' }])
    const result = detectOverwrittenHandEdits(
      { future_developments: handEdited },
      baseline,
      { future_developments: [{ text: 'second' }, { text: 'first' }, { text: 'third' }] },
    )
    expect(result).toEqual(['Future Developments'])
  })

  it('does NOT flag a JSON array field that only differs in whitespace/formatting', () => {
    const baseline = reconstructAiNarrativeBaseline(changedTurns({
      future_developments: [{ text: 'grow' }],
    }))
    const rePrettyPrinted = JSON.stringify([{ text: 'grow' }], null, 2)
    const result = detectOverwrittenHandEdits(
      { future_developments: rePrettyPrinted },
      baseline,
      { future_developments: [{ text: 'grow' }, { text: 'new item' }] },
    )
    expect(result).toEqual([])
  })

  it('does NOT flag an object whose keys are in a different order but same content', () => {
    const baseline = reconstructAiNarrativeBaseline(changedTurns({
      immediate_actions: [{ title: 'Sign', description: 'Do it now' }],
    }))
    const reordered = JSON.stringify([{ description: 'Do it now', title: 'Sign' }])
    const result = detectOverwrittenHandEdits(
      { immediate_actions: reordered },
      baseline,
      { immediate_actions: [{ title: 'Sign', description: 'Do it now' }, { title: 'Pay', description: 'Now' }] },
    )
    expect(result).toEqual([])
  })

  it('does not flag and does not throw on an empty/whitespace-only current value', () => {
    const baseline = reconstructAiNarrativeBaseline(changedTurns({ intro_it: 'Ciao.' }))
    expect(() => detectOverwrittenHandEdits({ intro_it: '   ' }, baseline, { intro_it: 'Ciao, updated.' })).not.toThrow()
    expect(detectOverwrittenHandEdits({ intro_it: '   ' }, baseline, { intro_it: 'Ciao, updated.' })).toEqual([])
  })

  it('fails safe (no flag, no throw) when the on-screen JSON is invalid — cannot safely compare', () => {
    const baseline = reconstructAiNarrativeBaseline(changedTurns({ strategy: [{ step_number: 1, title: 'A', description: 'B' }] }))
    const result = detectOverwrittenHandEdits(
      { strategy: '{not valid json' },
      baseline,
      { strategy: [{ step_number: 1, title: 'A', description: 'C' }] },
    )
    expect(result).toEqual([])
  })

  it('can flag multiple fields in the same turn', () => {
    const baseline = reconstructAiNarrativeBaseline(changedTurns({ intro_en: 'Hello.', intro_it: 'Ciao.' }))
    const result = detectOverwrittenHandEdits(
      { intro_en: 'Hello, hand-edited.', intro_it: 'Ciao, modificato a mano.' },
      baseline,
      { intro_en: 'Completely different.', intro_it: 'Del tutto diverso.' },
    )
    expect(result).toEqual(['Introduction (English)', 'Introduction (Italian)'])
  })
})
