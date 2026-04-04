import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabaseAdmin before import
const mockUpsert = vi.fn().mockResolvedValue({ error: null })
const mockFrom = vi.fn().mockReturnValue({ upsert: mockUpsert })

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: (table: string) => mockFrom(table) },
}))

// Mock global fetch
const mockFetch = vi.fn()
global.fetch = mockFetch as unknown as typeof fetch

describe('syncAirwallexDeposits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.AIRWALLEX_CLIENT_ID = 'test-client-id'
    process.env.AIRWALLEX_API_KEY = 'test-api-key'
  })

  it('should authenticate and fetch deposits', async () => {
    // Mock auth response
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'test-bearer-token' }),
      })
      // Mock deposits response
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            {
              id: 'dep_001',
              amount: 3000,
              currency: 'EUR',
              status: 'RECEIVED',
              created_at: '2026-03-19T10:00:00Z',
              sender: { name: 'ATCOACHING LLC' },
              reference: 'INV-2026-001',
            },
          ],
        }),
      })

    const { syncAirwallexDeposits } = await import('@/lib/airwallex-sync')
    const result = await syncAirwallexDeposits('2026-03-01', '2026-04-04')

    expect(result.added).toBe(1)
    expect(result.skipped).toBe(0)
    expect(result.errors).toBe(0)

    // Verify auth call
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const authCall = mockFetch.mock.calls[0]
    expect(authCall[0]).toContain('/authentication/login')
    expect(authCall[1].headers['x-client-id']).toBe('test-client-id')
    expect(authCall[1].headers['x-api-key']).toBe('test-api-key')

    // Verify deposits call
    const depositCall = mockFetch.mock.calls[1]
    expect(depositCall[0]).toContain('/deposits')
    expect(depositCall[1].headers['Authorization']).toBe('Bearer test-bearer-token')

    // Verify upsert called with correct data
    expect(mockFrom).toHaveBeenCalledWith('td_bank_feeds')
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'airwallex',
        external_id: 'airwallex_dep_001',
        amount: 3000,
        currency: 'EUR',
        sender_name: 'ATCOACHING LLC',
      }),
      { onConflict: 'external_id' }
    )
  })

  it('should skip non-completed deposits', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'test-token' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            { id: 'dep_pending', amount: 500, currency: 'EUR', status: 'PENDING', created_at: '2026-03-20T10:00:00Z' },
            { id: 'dep_ok', amount: 1000, currency: 'EUR', status: 'SETTLED', created_at: '2026-03-20T10:00:00Z', sender: { name: 'Test Co' } },
          ],
        }),
      })

    const { syncAirwallexDeposits } = await import('@/lib/airwallex-sync')
    const result = await syncAirwallexDeposits('2026-03-01', '2026-04-04')

    expect(result.added).toBe(1)
    expect(result.skipped).toBe(1)
  })

  it('should throw on missing credentials', async () => {
    delete process.env.AIRWALLEX_CLIENT_ID
    delete process.env.AIRWALLEX_API_KEY

    const { syncAirwallexDeposits } = await import('@/lib/airwallex-sync')
    await expect(syncAirwallexDeposits('2026-03-01', '2026-04-04')).rejects.toThrow('Airwallex credentials not configured')
  })

  it('should throw on auth failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    })

    const { syncAirwallexDeposits } = await import('@/lib/airwallex-sync')
    await expect(syncAirwallexDeposits('2026-03-01', '2026-04-04')).rejects.toThrow('Airwallex auth failed (401)')
  })

  it('should handle zero-amount deposits', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'tok' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            { id: 'dep_zero', amount: 0, currency: 'EUR', status: 'RECEIVED', created_at: '2026-03-20T10:00:00Z' },
          ],
        }),
      })

    const { syncAirwallexDeposits } = await import('@/lib/airwallex-sync')
    const result = await syncAirwallexDeposits('2026-03-01', '2026-04-04')

    expect(result.added).toBe(0)
    expect(result.skipped).toBe(1)
  })
})
