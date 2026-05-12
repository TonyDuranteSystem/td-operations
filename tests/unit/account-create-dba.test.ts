/**
 * Unit tests for app/(dashboard)/accounts/actions.ts::createDBA.
 *
 * Covers: required-field validation, happy path (createSD + dba_details
 * insert in that order), dba_details failure surfaces a useful error that
 * mentions the orphan SD id so an operator can recover.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

let createSDImpl = vi.fn(async (params: Record<string, unknown>) => ({
  id: 'sd-new-1',
  service_type: params.service_type as string,
  service_name: (params.service_name as string) ?? (params.service_type as string),
  stage: 'Data Collection',
  stage_order: 1,
  account_id: params.account_id as string,
  contact_id: null,
}))
let dbaInsertError: { message: string } | null = null
let lastDbaInsertPayload: Record<string, unknown> | null = null
const revalidatePathCalls: string[] = []

vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    revalidatePathCalls.push(path)
  },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: 'u1', email: 'admin@tonydurante.us' } }, error: null }),
    },
    from: () => ({
      insert: () => Promise.resolve({ error: null }),
    }),
  }),
}))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'dba_details') {
        return {
          insert: (payload: Record<string, unknown>) => {
            lastDbaInsertPayload = payload
            return Promise.resolve({ error: dbaInsertError })
          },
        }
      }
      return {
        insert: () => Promise.resolve({ error: null }),
      }
    },
  },
}))

vi.mock('@/lib/operations/service-delivery', () => ({
  createSD: (params: Record<string, unknown>) => createSDImpl(params),
}))

vi.mock('@/lib/operations/ein-received', () => ({
  triggerEINReceivedWorkflow: vi.fn(),
}))

vi.mock('@/lib/operations/sync-tier', () => ({
  syncTier: vi.fn(),
  syncContactTiersForAccount: vi.fn(),
}))

// Import after mocks register.
import { createDBA } from '@/app/(dashboard)/accounts/actions'

beforeEach(() => {
  createSDImpl = vi.fn(async (params: Record<string, unknown>) => ({
    id: 'sd-new-1',
    service_type: params.service_type as string,
    service_name: (params.service_name as string) ?? (params.service_type as string),
    stage: 'Data Collection',
    stage_order: 1,
    account_id: params.account_id as string,
    contact_id: null,
  }))
  dbaInsertError = null
  lastDbaInsertPayload = null
  revalidatePathCalls.length = 0
})

describe('createDBA', () => {
  it('rejects when dba_name is missing', async () => {
    const result = await createDBA('acct-1', { dba_name: '   ', jurisdiction: 'NY' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/dba name/i)
  })

  it('rejects when jurisdiction is missing', async () => {
    const result = await createDBA('acct-1', { dba_name: 'Acme', jurisdiction: '' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/jurisdiction/i)
  })

  it('creates SD with service_type=DBA and inserts dba_details on happy path', async () => {
    const result = await createDBA('acct-1', {
      dba_name: 'Acme Trading',
      jurisdiction: 'New York',
      notes: 'Filed in Manhattan',
    })
    expect(result.success).toBe(true)
    expect(result.data?.id).toBe('sd-new-1')

    expect(createSDImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        service_type: 'DBA',
        service_name: 'Acme Trading',
        account_id: 'acct-1',
        notes: 'Filed in Manhattan',
      }),
    )
    expect(lastDbaInsertPayload).toEqual({
      delivery_id: 'sd-new-1',
      dba_name: 'Acme Trading',
      jurisdiction: 'New York',
      notes: 'Filed in Manhattan',
    })
    expect(revalidatePathCalls).toContain('/accounts/acct-1')
  })

  it('trims surrounding whitespace from inputs', async () => {
    await createDBA('acct-1', {
      dba_name: '  Acme  ',
      jurisdiction: '  NY  ',
      notes: '  hi  ',
    })
    expect(lastDbaInsertPayload).toEqual({
      delivery_id: 'sd-new-1',
      dba_name: 'Acme',
      jurisdiction: 'NY',
      notes: 'hi',
    })
  })

  it('passes notes=null when notes is empty string', async () => {
    await createDBA('acct-1', {
      dba_name: 'Acme',
      jurisdiction: 'NY',
      notes: '   ',
    })
    expect(lastDbaInsertPayload).toEqual({
      delivery_id: 'sd-new-1',
      dba_name: 'Acme',
      jurisdiction: 'NY',
      notes: null,
    })
  })

  it('surfaces dba_details insert failure with the orphan SD id', async () => {
    dbaInsertError = { message: 'duplicate key' }
    const result = await createDBA('acct-1', {
      dba_name: 'Acme',
      jurisdiction: 'NY',
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/sd-new-1/)
    expect(result.error).toMatch(/duplicate key/)
  })
})
