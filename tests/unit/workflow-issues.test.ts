import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))

import {
  dispatchOutcomeLabel,
  dispatchSourceLabel,
  dispatchSeverity,
} from '@/lib/operations/workflow-issues'

describe('dispatchOutcomeLabel', () => {
  it('maps known outcomes to plain language', () => {
    expect(dispatchOutcomeLabel('no_trigger_match')).toBe('No matching workflow')
    expect(dispatchOutcomeLabel('ambiguous')).toBe('Ambiguous match')
    expect(dispatchOutcomeLabel('snapshot_invalid')).toBe('Invalid workflow snapshot')
    expect(dispatchOutcomeLabel('meta_invalid')).toBe('Invalid task data')
    expect(dispatchOutcomeLabel('spawn_failed')).toBe('Spawn failed')
  })
  it('falls back to the raw value for unknown outcomes', () => {
    expect(dispatchOutcomeLabel('something_new')).toBe('something_new')
  })
})

describe('dispatchSourceLabel', () => {
  it('maps known sources', () => {
    expect(dispatchSourceLabel('form_submission')).toBe('Form submission')
    expect(dispatchSourceLabel('sd_created')).toBe('Service created')
    expect(dispatchSourceLabel('chain')).toBe('Chain step')
  })
  it('falls back to the raw value', () => {
    expect(dispatchSourceLabel('mystery')).toBe('mystery')
  })
})

describe('dispatchSeverity', () => {
  it('treats ambiguous / no-match as config warnings', () => {
    expect(dispatchSeverity('ambiguous')).toBe('warn')
    expect(dispatchSeverity('no_trigger_match')).toBe('warn')
  })
  it('treats the rest as errors', () => {
    expect(dispatchSeverity('spawn_failed')).toBe('error')
    expect(dispatchSeverity('meta_invalid')).toBe('error')
    expect(dispatchSeverity('snapshot_invalid')).toBe('error')
  })
})
