import { describe, it, expect, vi, beforeEach } from 'vitest'

const inserted: Record<string, unknown>[] = []
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push({ table, ...row })
        return Promise.resolve({ error: null })
      },
    }),
  },
}))

import { logPartnerAccess, logPartnerFileGrants } from '@/lib/td-communication/partner-access-log'

describe('partner access log', () => {
  beforeEach(() => { inserted.length = 0 })

  it('writes one row with the surface, partner and detail', async () => {
    logPartnerAccess({ partnerId: 'p-1', surface: 'projects_list', method: 'GET', path: '/x', detail: { count: 2 } })
    await new Promise(r => setTimeout(r, 0))
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      table: 'partner_access_log',
      partner_id: 'p-1',
      surface: 'projects_list',
      detail: { count: 2 },
    })
  })

  it('file grants get ONE EXPLICIT ROW PER FILE (the Antonio requirement)', async () => {
    logPartnerFileGrants('p-1', 'enr-9', ['a/passport.pdf', 'a/ssn.png', 'a/logo.svg'])
    await new Promise(r => setTimeout(r, 0))
    expect(inserted).toHaveLength(3)
    expect(inserted.map(r => r.resource)).toEqual(['a/passport.pdf', 'a/ssn.png', 'a/logo.svg'])
    for (const row of inserted) {
      expect(row.surface).toBe('file_signed')
      expect(row.detail).toMatchObject({ enrollment_id: 'enr-9' })
    }
  })

  it('zero files → zero rows (no empty aggregates)', async () => {
    logPartnerFileGrants('p-1', 'enr-9', [])
    await new Promise(r => setTimeout(r, 0))
    expect(inserted).toHaveLength(0)
  })
})
