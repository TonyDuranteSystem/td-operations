import { describe, it, expect, vi, beforeEach } from 'vitest'

const setColumnPref = vi.fn()
const clearColumnPref = vi.fn()
let staff = true
let user: { id: string } | null = { id: 'u1' }

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth', () => ({ isStaffUser: () => staff }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user } }) } }) }))
vi.mock('@/app/(dashboard)/accounts/actions', () => ({ updateAccountField: vi.fn() }))
vi.mock('@/lib/crm-lists/prefs', () => ({
  setColumnPref: (...a: unknown[]) => setColumnPref(...a),
  clearColumnPref: (...a: unknown[]) => clearColumnPref(...a),
}))

import { resetListColumns, saveListColumns } from '@/app/(dashboard)/accounts/list-actions'

beforeEach(() => {
  setColumnPref.mockReset().mockResolvedValue(true)
  clearColumnPref.mockReset().mockResolvedValue(true)
  staff = true
  user = { id: 'u1' }
})

describe('saveListColumns', () => {
  it('saves the choice under the signed-in login', async () => {
    expect(await saveListColumns('contacts', ['email', 'phone'])).toEqual({ success: true })
    expect(setColumnPref).toHaveBeenCalledWith('u1', 'contacts', ['email', 'phone'])
  })
  it('is for staff only', async () => {
    staff = false
    expect((await saveListColumns('contacts', ['email'])).success).toBe(false)
    user = null
    staff = true
    expect((await saveListColumns('contacts', ['email'])).success).toBe(false)
    expect(setColumnPref).not.toHaveBeenCalled()
  })
  it('refuses an unknown list', async () => {
    expect((await saveListColumns('leads', ['email'])).success).toBe(false)
    expect(setColumnPref).not.toHaveBeenCalled()
  })
  it('tells the person when the save failed', async () => {
    setColumnPref.mockResolvedValue(false)
    const r = await saveListColumns('accounts', ['ein'])
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/try again/i)
  })
  it('does not pass a non-list through', async () => {
    await saveListColumns('accounts', 'ein' as unknown as string[])
    expect(setColumnPref).toHaveBeenCalledWith('u1', 'accounts', [])
  })
})

describe('resetListColumns', () => {
  it('forgets the choice for that list only', async () => {
    expect(await resetListColumns('accounts')).toEqual({ success: true })
    expect(clearColumnPref).toHaveBeenCalledWith('u1', 'accounts')
  })
  it('is for staff only and for known lists', async () => {
    staff = false
    expect((await resetListColumns('accounts')).success).toBe(false)
    staff = true
    expect((await resetListColumns('nope')).success).toBe(false)
    expect(clearColumnPref).not.toHaveBeenCalled()
  })
})
