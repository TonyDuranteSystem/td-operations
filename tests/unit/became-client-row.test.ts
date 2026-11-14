import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/app/(dashboard)/accounts/actions', () => ({ setBecameClientHow: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn() } }))

import { BecameClientRow } from '@/components/accounts/became-client-row'

const base = {
  accountId: 'acc-1',
  companyName: '2L Consulting LLC',
  accountType: 'Client' as string | null,
  updatedAt: 'U1',
  value: null as string | null,
  checkedAt: null as string | null,
  checkedBy: null as string | null,
  guess: { value: 'formed_by_us' as const, hint: 'The signed formation contract (May 27, 2026) says we formed it.' } as { value: 'formed_by_us' | 'onboarded'; hint: string } | null,
  formationDate: '2026-05-20',
  clientSince: null as string | null,
  raSwitchDate: null as string | null,
}
const html = (over: Partial<typeof base> = {}) => renderToStaticMarkup(createElement(BecameClientRow, { ...base, ...over }))
const selected = (h: string) => /<option value="([^"]*)" selected/.exec(h)?.[1] ?? /<select[^>]*value="([^"]*)"/.exec(h)?.[1] ?? null

describe('BecameClientRow — what is on screen when the page loads', () => {
  it('a client company with no saved answer shows the guess, marked To check, with its source and the confirm button', () => {
    const h = html()
    expect(h).toContain('To check')
    expect(h).toContain('The signed formation contract (May 27, 2026) says we formed it.')
    expect(h).toContain('It&#x27;s correct')
    expect(h).not.toContain('Not set')
    expect(selected(h)).toBe('formed_by_us')
  })

  it('works the same for a company that is not active (the guess does not depend on the status)', () => {
    expect(html({ guess: { value: 'onboarded', hint: 'Client Since is filled in, which usually means it already existed (onboarded).' }, clientSince: '2026-04-18' })).toContain('To check')
  })

  it('a saved but unchecked answer shows it, with the hint when the records agree', () => {
    const h = html({ value: 'formed_by_us' })
    expect(h).toContain('To check')
    expect(h).toContain('The signed formation contract (May 27, 2026) says we formed it.')
  })

  it('a saved answer the records now disagree with says so', () => {
    const h = html({ value: 'onboarded', clientSince: '2026-04-18' })
    expect(h).toContain('The records point to Formed by us instead.')
    expect(h).toContain('It&#x27;s correct') // still possible; the pop-up shows the warning first
  })

  it('when the contract could not be read the row says so instead of showing a made-up hint', () => {
    const h = html({ value: 'onboarded', guess: null, clientSince: '2026-04-18' })
    expect(h).toContain('The signed contract could not be read just now')
    expect(h).toContain('To check')
  })

  it('no saved answer and nothing could be read: Not set, no tag, no confirm button', () => {
    const h = html({ guess: null })
    expect(h).toContain('Not set')
    expect(h).not.toContain('To check')
    expect(h).not.toContain('It&#x27;s correct')
  })

  it('a checked answer shows Checked, who and the New York day, and no confirm button or guess line', () => {
    const h = html({ value: 'onboarded', checkedAt: '2026-11-15T01:30:00+00:00', checkedBy: 'dashboard:antonio.durante', guess: null })
    expect(h).toContain('Checked')
    expect(h).toContain('by antonio.durante on Nov 14, 2026') // 8:30 pm Nov 14 in New York, not Nov 15
    expect(h).not.toContain('To check')
    expect(h).not.toContain('It&#x27;s correct')
    expect(h).not.toContain('could not be read')
  })

  it('a company that is not a client and has no answer shows nothing; one that has an answer shows it without a tag', () => {
    expect(html({ accountType: 'Lead', guess: null })).toBe('')
    const h = html({ accountType: 'Closed', value: 'onboarded', guess: null })
    expect(h).toContain('Onboarded')
    expect(h).not.toContain('To check')
  })

  it('the pop-up is closed when the page loads', () => {
    expect(html()).not.toContain('role="dialog"')
  })
})
