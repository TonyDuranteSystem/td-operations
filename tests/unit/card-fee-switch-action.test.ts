import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * toggleCardFee — the Finance-dashboard kill-switch action (Council Phase A).
 * The admin gate must live INSIDE the action: page-level visibility is not a
 * security boundary, so a non-admin staff login calling the action directly
 * must be rejected before any write happens.
 */

let currentUser: { id: string; email: string } | null = null
let userIsAdmin = false
const setterCalls: Array<{ enabled: boolean; actor: string }> = []

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: currentUser } }) },
  }),
}))

vi.mock('@/lib/auth', () => ({
  isAdmin: () => userIsAdmin,
}))

vi.mock('@/lib/payments/card-fee-config', () => ({
  setCardFeeEnabled: (enabled: boolean, actor: string) => {
    setterCalls.push({ enabled, actor })
    return Promise.resolve()
  },
}))

vi.mock('@/lib/server-action', () => ({
  safeAction: async (fn: () => Promise<unknown>) => {
    try {
      return { success: true, data: await fn() }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}))

import { toggleCardFee } from '@/app/(dashboard)/finance/actions'

beforeEach(() => {
  currentUser = null
  userIsAdmin = false
  setterCalls.length = 0
})

describe('toggleCardFee — role gate inside the action', () => {
  it('rejects an anonymous caller without touching the switch', async () => {
    const res = await toggleCardFee(false)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/admin/i)
    expect(setterCalls).toHaveLength(0)
  })

  it('rejects a logged-in NON-admin without touching the switch', async () => {
    currentUser = { id: 'u1', email: 'staff@tonydurante.us' }
    userIsAdmin = false
    const res = await toggleCardFee(false)
    expect(res.success).toBe(false)
    expect(setterCalls).toHaveLength(0)
  })

  it('lets an admin flip the switch and stamps the actor', async () => {
    currentUser = { id: 'u2', email: 'antonio@tonydurante.us' }
    userIsAdmin = true
    const res = await toggleCardFee(false)
    expect(res.success).toBe(true)
    expect(setterCalls).toEqual([{ enabled: false, actor: 'finance-ui:antonio@tonydurante.us' }])
  })
})
