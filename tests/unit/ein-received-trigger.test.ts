/**
 * Unit tests for triggerEINReceivedWorkflow.
 *
 * The helper is the shared core invoked by:
 *   1. The "Record EIN Received" button (via record-ein-received API) — pending
 *   2. The inline EIN edit on the Account Details page (updateAccountField)
 *
 * Contract verified here:
 *   - Returns success=false when no active Company Formation SD exists
 *   - NEVER creates a Banking Fintech SD (removed 2026-06-20 — formation ends at
 *     the EIN; banking is self-service). banking_sd_id is always null.
 *   - Advances Formation SD, syncs tier to active, enqueues welcome_package_prepare
 *   - Always writes an action_log entry
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const actionLogInserts: Array<Record<string, unknown>> = []
const enqueueCalls: Array<Record<string, unknown>> = []
const createSDCalls: Array<Record<string, unknown>> = []
const advanceStageCalls: Array<Record<string, unknown>> = []
const syncTierCalls: Array<Record<string, unknown>> = []

let nextAccount: { id: string; company_name: string; portal_tier: string | null } | null = null
let nextFormationSDs: Array<{ id: string; stage: string | null; contact_id: string | null }> = []
let nextExistingBankingSD: { id: string } | null = null

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
          maybeSingle: () => Promise.resolve({ data: nextExistingBankingSD, error: null }),
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
  createSD: (params: Record<string, unknown>) => {
    createSDCalls.push(params)
    return Promise.resolve({ id: 'banking-sd-new', service_type: 'Banking Fintech', service_name: 'Banking Fintech' })
  },
  advanceStage: (params: Record<string, unknown>) => {
    advanceStageCalls.push(params)
    return Promise.resolve({ success: true })
  },
}))

vi.mock('@/lib/operations/sync-tier', () => ({
  syncTier: (params: Record<string, unknown>) => {
    syncTierCalls.push(params)
    return Promise.resolve({ success: true, previousTier: 'formation', newTier: 'active', contactsUpdated: [] })
  },
}))

vi.mock('@/lib/jobs/queue', () => ({
  enqueueJob: (params: Record<string, unknown>) => {
    enqueueCalls.push(params)
    return Promise.resolve({ id: 'job-1' })
  },
}))

import { triggerEINReceivedWorkflow } from '@/lib/operations/ein-received'

beforeEach(() => {
  actionLogInserts.length = 0
  enqueueCalls.length = 0
  createSDCalls.length = 0
  advanceStageCalls.length = 0
  syncTierCalls.length = 0
  nextAccount = { id: 'acct-1', company_name: 'Test LLC', portal_tier: 'formation' }
  nextFormationSDs = [{ id: 'fsd-1', stage: 'SS-4 Signed', contact_id: 'cont-1' }]
  nextExistingBankingSD = null
})

describe('triggerEINReceivedWorkflow — happy path', () => {
  it('advances Formation SD, syncs tier, enqueues welcome job, logs — and NEVER creates a Banking SD', async () => {
    const result = await triggerEINReceivedWorkflow({
      accountId: 'acct-1',
      einNumber: '30-1482516',
      actor: 'dashboard:antonio',
    })

    expect(result.success).toBe(true)
    expect(result.formation_sd_id).toBe('fsd-1')
    // Banking Fintech SD is no longer created (formation ends at the EIN).
    expect(result.banking_sd_id).toBeNull()
    expect(createSDCalls).toHaveLength(0)
    expect(result.side_effects).toContain('banking_sd_skipped')
    expect(result.welcome_package_job_id).toBe('job-1')

    expect(advanceStageCalls).toHaveLength(1)
    expect(advanceStageCalls[0].delivery_id).toBe('fsd-1')
    expect(advanceStageCalls[0].target_stage).toBe('EIN Received')

    expect(syncTierCalls).toHaveLength(1)
    expect(syncTierCalls[0].accountId).toBe('acct-1')
    expect(syncTierCalls[0].newTier).toBe('active')

    expect(enqueueCalls).toHaveLength(1)
    expect(enqueueCalls[0].job_type).toBe('welcome_package_prepare')

    expect(actionLogInserts).toHaveLength(1)
    expect(actionLogInserts[0].action_type).toBe('record_ein_received')
    expect(actionLogInserts[0].account_id).toBe('acct-1')
  })
})

describe('triggerEINReceivedWorkflow — no banking SD', () => {
  it('never creates a Banking SD even if one already exists on the account', async () => {
    nextExistingBankingSD = { id: 'banking-sd-existing' }
    const result = await triggerEINReceivedWorkflow({
      accountId: 'acct-1',
      einNumber: '30-1482516',
    })

    expect(result.success).toBe(true)
    expect(result.banking_sd_id).toBeNull()
    expect(createSDCalls).toHaveLength(0)
    expect(result.side_effects).toContain('banking_sd_skipped')
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
    expect(createSDCalls).toHaveLength(0)
    expect(advanceStageCalls).toHaveLength(0)
    expect(syncTierCalls).toHaveLength(0)
    expect(enqueueCalls).toHaveLength(0)
  })

  it('returns success=false when no active Company Formation SD exists', async () => {
    nextFormationSDs = []
    const result = await triggerEINReceivedWorkflow({
      accountId: 'acct-1',
      einNumber: '30-1482516',
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/No active Company Formation/)
    expect(createSDCalls).toHaveLength(0)
    expect(advanceStageCalls).toHaveLength(0)
    expect(syncTierCalls).toHaveLength(0)
  })
})
