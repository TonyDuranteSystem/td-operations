import { describe, it, expect } from 'vitest'
import { readAllPages } from '@/lib/crm-store/paged'

const fake = (total: number) => (from: number, to: number) =>
  Promise.resolve({ data: Array.from({ length: Math.max(0, Math.min(to + 1, total) - from) }, (_, i) => from + i), error: null })

describe('readAllPages', () => {
  it('returns everything across several pages (more than 1000 rows)', async () => {
    const rows = await readAllPages<number>(fake(2503))
    expect(rows.length).toBe(2503)
    expect(rows[1000]).toBe(1000)
    expect(rows[2502]).toBe(2502)
  })
  it('stops after a short page and handles an exact multiple', async () => {
    expect((await readAllPages<number>(fake(0))).length).toBe(0)
    expect((await readAllPages<number>(fake(999))).length).toBe(999)
    expect((await readAllPages<number>(fake(2000))).length).toBe(2000)
  })
  it('throws on a database error instead of returning a partial list', async () => {
    await expect(readAllPages<number>(() => Promise.resolve({ data: null, error: { message: 'boom' } }))).rejects.toThrow('boom')
  })
})
