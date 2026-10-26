import { beforeEach, describe, expect, it, vi } from 'vitest'

const recent = vi.hoisted(() => ({ rows: [] as Array<{ id: string }>, error: null as null | { message: string }, calls: [] as string[], patterns: [] as string[] }))
const report = vi.hoisted(() => vi.fn())
const post = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (t: string) => {
      recent.calls.push(t)
      const chain = {
        select: () => chain, eq: () => chain, ilike: (_c: string, pat: string) => { recent.patterns.push(pat); return chain }, gte: () => chain,
        limit: async () => ({ data: recent.rows, error: recent.error }),
      }
      return chain
    },
  },
}))
vi.mock('@/lib/system-errors', () => ({ reportSystemError: (...a: unknown[]) => report(...a) }))
vi.mock('@/lib/team/post-message', () => ({ postTeamMessage: (...a: unknown[]) => post(...a) }))

import { alertMissingContractWording, missingWordingMessage } from '@/lib/offers/contract-wording-alert'

beforeEach(() => { recent.rows = []; recent.error = null; recent.calls.length = 0; report.mockReset(); post.mockReset(); report.mockResolvedValue(undefined); post.mockResolvedValue({}) })

describe('alertMissingContractWording', () => {
  it('tells staff in the bug channel AND records it, in plain words with the fix', async () => {
    await alertMissingContractWording('mario-2026', ['custom_apostille'])
    expect(report).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledTimes(1)
    const posted = post.mock.calls[0][0] as { channel: string; message: string }
    expect(posted.channel).toBe('td-bug')
    expect(posted.message).toContain('mario-2026')
    expect(posted.message).toContain('custom_apostille')
    expect(posted.message).toMatch(/Fix: open the service in the Service Catalog/)
    expect(posted.message).toContain('The offer needs no change')
  })

  it('says it only once per offer per six hours (a refreshing client cannot flood the channel)', async () => {
    recent.rows = [{ id: 'e1' }]
    await alertMissingContractWording('mario-2026', ['custom_apostille'])
    expect(report).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('never throws: a failed chat post or error write does not break the client\'s page', async () => {
    post.mockRejectedValue(new Error('chat down'))
    await expect(alertMissingContractWording('t', ['custom_a'])).resolves.toBeUndefined()
    report.mockRejectedValue(new Error('db down'))
    await expect(alertMissingContractWording('t', ['custom_a'])).resolves.toBeUndefined()
  })

  it('the message lists every type that is missing', () => {
    expect(missingWordingMessage('t', ['custom_a', 'custom_b'])).toContain('custom_a, custom_b')
  })
})

describe('the alert for a FAILURE to prepare the wording (not a missing approval)', () => {
  it('says what failed, to whom it matters, and what to do', () => {
    const m = missingWordingMessage('tok', ['custom_apostille'], 'db down')
    expect(m).toContain('could not prepare the contract wording of custom_apostille (db down)')
    expect(m).toContain('your agreement is being prepared')
    expect(missingWordingMessage('tok', ['custom_apostille'])).toContain('is not approved')
  })
})

describe('the once-per-six-hours guard matches the WHOLE token, not a piece of a longer one', () => {
  it('looks for "offer <token>," so another offer whose token merely contains this one is not silenced', async () => {
    recent.patterns.length = 0
    const { alertMissingContractWording } = await import('@/lib/offers/contract-wording-alert')
    await alertMissingContractWording('smith-2026', ['custom_apostille'])
    expect(recent.patterns).toEqual(['%offer smith-2026,%'])
  })
})
