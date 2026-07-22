import { describe, it, expect, vi, afterEach } from 'vitest'
import { countOrFailOpen } from '@/lib/portal/queries'

// The whole point of this helper: hiding a nav section is the EXPENSIVE failure
// (the client loses the only route to their documents), showing an empty one is
// cheap. So a failed count must NOT read as "this client has nothing".
describe('countOrFailOpen', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns the real count on success', async () => {
    await expect(countOrFailOpen('oa', Promise.resolve({ count: 3, error: null }))).resolves.toBe(3)
  })

  it('returns 0 — hiding the section — only when the query genuinely succeeds with none', async () => {
    await expect(countOrFailOpen('oa', Promise.resolve({ count: 0, error: null }))).resolves.toBe(0)
  })

  it('treats a null count with no error as zero', async () => {
    await expect(countOrFailOpen('oa', Promise.resolve({ count: null, error: null }))).resolves.toBe(0)
  })

  it('FAILS OPEN on a PostgREST error rather than hiding the section', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      countOrFailOpen('oa', Promise.resolve({ count: null, error: { message: 'statement timeout' } })),
    ).resolves.toBe(1)
    expect(spy).toHaveBeenCalled()
  })

  it('FAILS OPEN when the query rejects outright', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(countOrFailOpen('billing', Promise.reject(new Error('socket hang up')))).resolves.toBe(1)
    expect(spy).toHaveBeenCalled()
  })

  it('never throws — a throw inside the portal root layout would blank the whole portal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(countOrFailOpen('deadlines', Promise.reject('not even an Error'))).resolves.toBe(1)
  })
})
