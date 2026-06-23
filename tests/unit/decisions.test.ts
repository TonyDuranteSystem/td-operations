import { describe, it, expect } from 'vitest'
import {
  validateDecisionResponse,
  validateDecisionOptions,
  isDecisionRequestType,
  DECISION_REQUEST_TYPES,
} from '@/lib/decisions'

describe('isDecisionRequestType', () => {
  it('accepts only the 3 approved types', () => {
    expect(DECISION_REQUEST_TYPES).toEqual(['approval', 'choice', 'text_input'])
    expect(isDecisionRequestType('approval')).toBe(true)
    expect(isDecisionRequestType('choice')).toBe(true)
    expect(isDecisionRequestType('text_input')).toBe(true)
    expect(isDecisionRequestType('name_proposal')).toBe(false)
    expect(isDecisionRequestType('document_approval')).toBe(false)
    expect(isDecisionRequestType('')).toBe(false)
  })
})

describe('validateDecisionResponse — approval', () => {
  it('approved → status approved, keeps optional note', () => {
    const r = validateDecisionResponse('approval', { decision: 'approved', note: 'looks good' }, {})
    expect(r.ok).toBe(true)
    expect(r.status).toBe('approved')
    expect(r.response).toEqual({ decision: 'approved', note: 'looks good' })
  })
  it('rejected → status rejected, drops empty note', () => {
    const r = validateDecisionResponse('approval', { decision: 'rejected', note: '  ' }, {})
    expect(r.ok).toBe(true)
    expect(r.status).toBe('rejected')
    expect(r.response).toEqual({ decision: 'rejected' })
  })
  it('rejects an invalid decision value', () => {
    expect(validateDecisionResponse('approval', { decision: 'maybe' }, {}).ok).toBe(false)
    expect(validateDecisionResponse('approval', {}, {}).ok).toBe(false)
  })
})

describe('validateDecisionResponse — choice', () => {
  const options = { choices: [{ key: 'name_1', label: 'Aurora' }, { key: 'name_2', label: 'Cypress' }] }
  it('accepts a selected key that is among the choices', () => {
    const r = validateDecisionResponse('choice', { selected: 'name_2', note: 'this one' }, options)
    expect(r.ok).toBe(true)
    expect(r.status).toBe('responded')
    expect(r.response).toEqual({ selected: 'name_2', note: 'this one' })
  })
  it('rejects a selected key not among the choices', () => {
    expect(validateDecisionResponse('choice', { selected: 'name_9' }, options).ok).toBe(false)
  })
  it('requires a selected value', () => {
    expect(validateDecisionResponse('choice', { note: 'x' }, options).ok).toBe(false)
  })
  it('accepts any selected when no choices are configured (keys not enforced)', () => {
    expect(validateDecisionResponse('choice', { selected: 'whatever' }, {}).ok).toBe(true)
  })
})

describe('validateDecisionResponse — text_input', () => {
  it('accepts non-empty text', () => {
    const r = validateDecisionResponse('text_input', { text: 'NameA, NameB, NameC' }, {})
    expect(r.ok).toBe(true)
    expect(r.status).toBe('responded')
    expect(r.response).toEqual({ text: 'NameA, NameB, NameC' })
  })
  it('rejects empty / missing text', () => {
    expect(validateDecisionResponse('text_input', { text: '   ' }, {}).ok).toBe(false)
    expect(validateDecisionResponse('text_input', {}, {}).ok).toBe(false)
  })
})

describe('validateDecisionResponse — guards', () => {
  it('rejects unknown type and non-object response', () => {
    expect(validateDecisionResponse('name_proposal', { decision: 'approved' }, {}).ok).toBe(false)
    expect(validateDecisionResponse('approval', null, {}).ok).toBe(false)
    expect(validateDecisionResponse('approval', 'approved', {}).ok).toBe(false)
  })
})

describe('validateDecisionOptions', () => {
  it('approval / text_input accept any options', () => {
    expect(validateDecisionOptions('approval', {}).ok).toBe(true)
    expect(validateDecisionOptions('text_input', { required: true }).ok).toBe(true)
  })
  it('choice requires a non-empty choices array with key+label', () => {
    expect(validateDecisionOptions('choice', { choices: [] }).ok).toBe(false)
    expect(validateDecisionOptions('choice', {}).ok).toBe(false)
    expect(validateDecisionOptions('choice', { choices: [{ key: 'a' }] }).ok).toBe(false)
    expect(validateDecisionOptions('choice', { choices: [{ key: 'a', label: 'A' }] }).ok).toBe(true)
  })
  it('rejects unknown type', () => {
    expect(validateDecisionOptions('document_approval', {}).ok).toBe(false)
  })
})
