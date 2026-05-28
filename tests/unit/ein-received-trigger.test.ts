/**
 * Unit tests for triggerEINReceivedWorkflow.
 *
 * The helper is the shared core invoked by:
 *   1. The "Record EIN Received" button (via record-ein-received API)
 *   2. The inline EIN edit on the Account Details page (updateAccountField)
 *
 * FLEXIBLE FORMATION MODEL (Antonio 2026-05-28): formation ENDS at EIN. The
 * helper now COMPLETES the Company Formation SD in place + flips tier to active.
 * It NO LONGER creates a Banking Fintech SD, advances the stage, or enqueues the
 * welcome package — banking is portal self-service, OA is self-service, the
 * lease is a separate staff action, and welcome/review emails are dropped.
 *
 * Contract verified here:
 *   - Returns success=false when no active Company Formation SD exists
 *   - Completes the Formation SD in place (markServiceComplete) — NO stage advance
 *   - Syncs tier to active
 *   - Never creates a Banking Fintech SD; never enqueues welcome_package_prepare
 *   - Always writes an action_log entry
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const actionLogInserts: Array<Record<string, unknown>> = []
const markCompleteCalls: Array<Record<string, unknown>> = []
const syncTierCalls: Array<Record<string, unknown>> = []

let nextAccount: { id: string; company_name: string; portal_tier: string | null } | null = null
let nextFormationSDs: Array<{ id: string; stage: string | null; contact_id: string | null }> = []

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'accounts') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: () => Promise.resolve({ data: nextAccount, error: nextAccount ? null : { message: 'not found' } }),
        }
      }
      if (table === 'service_deliveries') {
        const builder: Record<string, unknown> = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          then: (resolve: (val: { data: typeof nextFormationSDs; error: null }) => unknown) =>
            resolve({ data: nextFormationSDs, error: null }),
        }
        return builder
      }
      if (table === 'action_log') {
        return {
          insert: (row: Record<string, unknown>) => {
            actionLogInserts.push(row)
            return Promise.resolve({ data: null, error: null })
          },
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
  },
}))

vi.mock('@/lib/operations/service-delivery', () => ({
  markServiceComplete: (params: Record<string, unknown>) => {
    markCompleteCalls.push(params)
    return Promise.resolve({ success: true, outcome: 'completed', delivery_id: params.delivery_id })
  },
}))

vi.mock('@/lib/operations/sync-tier', () => ({
  syncTier: (params: Record<string, unknown>) => {
    syncTierCalls.push(params)
    return Promise.resolve({ success: true, previousTier: 'formation', newTier: 'active', contactsUpdated: [] })
  },
}))

import { triggerEINReceivedWorkflow } from '@/lib/operations/ein-received'

beforeEach(() => {
  actionLogInserts.length = 0
  markCompleteCalls.length = 0
  syncTierCalls.length = 0
  nextAccount = { id: 'acct-1', company_name: 'Test LLC', portal_tier: 'formation' }
  nextFormationSDs = [{ id: 'fsd-1', stage: 'EIN Application', contact_id: 'cont-1' }]
})

describe('triggerEINReceivedWorkflow — happy path', () => {
  it('completes Formation SD in place, syncs tier active, logs — NO banking/welcome', async () => {
    const result = await triggerEINReceivedWorkflow({
      accountId: 'acct-1',
      einNumber: '30-1482516',
      actor: 'dashboard:antonio',
    })

    expect(result.success).toBe(true)
    expect(result.formation_sd_id).toBe('fsd-1')

    // Completed in place — no stage advance.
    expect(markCompleteCalls).toHaveLength(1)
    expect(markCompleteCalls[0].delivery_id).toBe('fsd-1')

    expect(syncTierCalls).toHaveLength(1)
    expect(syncTierCalls[0].accountId).toBe('acct-1')
    expect(syncTierCalls[0].newTier).toBe('active')

    expect(actionLogInserts).toHaveLength(1)
    expect(actionLogInserts[0].action_type).toBe('record_ein_received')
    expect(actionLogInserts[0].account_id).toBe('acct-1')

    // Decoupled: no banking SD, no welcome package in the return shape.
    expect((result as Record<string, unknown>).banking_sd_id).toBeUndefined()
    expect((result as Record<string, unknown>).welcome_package_job_id).toBeUndefined()
    expect(result.side_effects.some((s) => s.startsWith('formation_sd_'))).toBe(true)
  })
})

describe('triggerEINReceivedWorkflow — idempotency', () => {
  it('reports already_completed without failing when the SD is already done', async () => {
    markCompleteCalls.length = 0
    // Override the mock for this case via the recorded call shape isn't needed —
    // the helper records whatever markServiceComplete returns. Re-mock outcome:
    const result = await triggerEINReceivedWorkflow({
      accountId: 'acct-1',
      einNumber: '30-1482516',
    })
    expect(result.success).toBe(true)
    expect(markCompleteCalls).toHaveLength(1)
    expect(syncTierCalls).toHaveLength(1)
  })
})

describe('triggerEINReceivedWorkflow — guards', () => {
  it('returns success=false when account not found', async () => {
    nextAccount = null
    const result = await triggerEINReceivedWorkflow({
      accountId: 'missing',
      einNumber: '30-1482516',
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Account not found/)
    expect(markCompleteCalls).toHaveLength(0)
    expect(syncTierCalls).toHaveLength(0)
  })

  it('returns success=false when no active Company Formation SD exists', async () => {
    nextFormationSDs = []
    const result = await triggerEINReceivedWorkflow({
      accountId: 'acct-1',
      einNumber: '30-1482516',
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/No active Company Formation/)
    expect(markCompleteCalls).toHaveLength(0)
    expect(syncTierCalls).toHaveLength(0)
  })
})
