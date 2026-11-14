import { describe, it, expect, vi, beforeEach } from 'vitest'

const revalidatePath = vi.fn()
const updateAccountField = vi.fn()
const reads: Array<{ data: unknown; error: unknown }> = []
let staff = true

vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }))
vi.mock('@/lib/auth', () => ({ isStaffUser: () => staff }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => reads.shift() ?? { data: null, error: null } }) }) }),
  }),
}))
vi.mock('@/app/(dashboard)/accounts/actions', () => ({
  updateAccountField: (...args: unknown[]) => updateAccountField(...args),
}))

import { saveListAmount } from '@/app/(dashboard)/accounts/list-actions'

beforeEach(() => {
  revalidatePath.mockReset()
  updateAccountField.mockReset()
  updateAccountField.mockResolvedValue({ success: true })
  reads.length = 0
  staff = true
})

describe('saveListAmount', () => {
  it('saves a typed "1,250" as 1250 through the Account page save and refreshes both lists', async () => {
    reads.push({ data: { status: 'Active' }, error: null }, { data: { updated_at: '2026-11-14T10:00:00Z' }, error: null })
    const r = await saveListAmount('acc-1', 'installment_1_amount', '1,250', '2026-11-01T00:00:00Z')
    expect(r).toEqual({ success: true, amount: 1250, updatedAt: '2026-11-14T10:00:00Z' })
    expect(updateAccountField).toHaveBeenCalledWith('acc-1', 'installment_1_amount', '1250', '2026-11-01T00:00:00Z')
    expect(revalidatePath).toHaveBeenCalledWith('/accounts')
    expect(revalidatePath).toHaveBeenCalledWith('/contacts')
  })

  it.each(['Closed', 'Cancelled', 'Offboarding'])('refuses a %s company on the server and writes nothing', async (status) => {
    reads.push({ data: { status }, error: null })
    const r = await saveListAmount('acc-1', 'installment_2_amount', '900', 'x')
    expect(r.success).toBe(false)
    expect(r.error).toContain(status)
    expect(updateAccountField).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('reads the company status fresh, so a stale screen cannot unlock a closed company', async () => {
    // the screen was drawn while the company was Active; by the time of the save it is Closed
    reads.push({ data: { status: 'Closed' }, error: null })
    expect((await saveListAmount('acc-1', 'installment_1_amount', '1000', 'old')).success).toBe(false)
    expect(updateAccountField).not.toHaveBeenCalled()
  })

  it('clears an amount when the box is empty', async () => {
    reads.push({ data: { status: 'Active' }, error: null }, { data: { updated_at: 't2' }, error: null })
    const r = await saveListAmount('acc-1', 'setup_fee_amount', '', 't1')
    expect(r).toEqual({ success: true, amount: null, updatedAt: 't2' })
    expect(updateAccountField).toHaveBeenCalledWith('acc-1', 'setup_fee_amount', '', 't1')
  })

  it('refuses a field that is not an amount', async () => {
    reads.push({ data: { status: 'Active' }, error: null })
    const r = await saveListAmount('acc-1', 'status', 'Closed', 't1')
    expect(r.success).toBe(false)
    expect(updateAccountField).not.toHaveBeenCalled()
  })

  it('refuses text that is not an amount', async () => {
    reads.push({ data: { status: 'Active' }, error: null })
    const r = await saveListAmount('acc-1', 'installment_1_amount', 'abc', 't1')
    expect(r.success).toBe(false)
    expect(updateAccountField).not.toHaveBeenCalled()
  })

  it('passes a stale-screen refusal back with its own words and refreshes nothing', async () => {
    reads.push({ data: { status: 'Active' }, error: null })
    updateAccountField.mockResolvedValue({ success: false, error: 'This record was changed by someone else. Reload and try again.' })
    const r = await saveListAmount('acc-1', 'installment_1_amount', '1000', 'old')
    expect(r).toEqual({ success: false, error: 'This record was changed by someone else. Reload and try again.' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('is staff only', async () => {
    staff = false
    const r = await saveListAmount('acc-1', 'installment_1_amount', '1000', 't1')
    expect(r).toEqual({ success: false, error: 'Not allowed.' })
    expect(updateAccountField).not.toHaveBeenCalled()
  })

  it('says so when the company cannot be found', async () => {
    reads.push({ data: null, error: null })
    const r = await saveListAmount('missing', 'installment_1_amount', '1000', 't1')
    expect(r.success).toBe(false)
    expect(updateAccountField).not.toHaveBeenCalled()
  })
})
