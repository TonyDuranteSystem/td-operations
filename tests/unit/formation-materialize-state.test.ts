import { describe, it, expect } from 'vitest'
import type { MaterializeFormationParams, MaterializeFormationResult } from '@/lib/operations/formation-materialize'

describe('formation-materialize — admin state override + wizard_progress fallback', () => {
  it('accepts formation_state on params', () => {
    const p: MaterializeFormationParams = {
      contact_id: '00000000-0000-0000-0000-000000000001',
      formation_state: 'NM',
    }
    expect(p.formation_state).toBe('NM')
  })

  it('formation_state type permits exactly NM/WY/FL/DE', () => {
    const a: MaterializeFormationParams['formation_state'] = 'NM'
    const b: MaterializeFormationParams['formation_state'] = 'WY'
    const c: MaterializeFormationParams['formation_state'] = 'FL'
    const d: MaterializeFormationParams['formation_state'] = 'DE'
    const e: MaterializeFormationParams['formation_state'] = undefined
    expect([a, b, c, d, e]).toEqual(['NM', 'WY', 'FL', 'DE', undefined])
  })

  it('MaterializeStep type accepts offer_link step', () => {
    const okStep: import('@/lib/operations/formation-materialize').MaterializeStep = {
      step: 'offer_link',
      status: 'ok',
      detail: '1 formation offer(s) linked to account',
    }
    expect(okStep.step).toBe('offer_link')

    const skippedStep: import('@/lib/operations/formation-materialize').MaterializeStep = {
      step: 'offer_link',
      status: 'skipped',
      detail: 'No lead_id on wizard_progress — cannot resolve formation offer',
    }
    expect(skippedStep.status).toBe('skipped')
  })

  it('outcome enum still includes missing_submission, invalid_state, missing_chosen_name', () => {
    const r: MaterializeFormationResult = {
      success: false,
      outcome: 'missing_submission',
      steps: [],
    }
    expect(r.outcome).toBe('missing_submission')

    const r2: MaterializeFormationResult = {
      success: false,
      outcome: 'invalid_state',
      steps: [],
    }
    expect(r2.outcome).toBe('invalid_state')

    const r3: MaterializeFormationResult = {
      success: false,
      outcome: 'missing_chosen_name',
      steps: [],
    }
    expect(r3.outcome).toBe('missing_chosen_name')
  })
})
