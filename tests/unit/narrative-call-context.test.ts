/**
 * The "Discuss with AI" offer-narrative box's read-only call-transcript
 * lookup (2026-09-16) — Antonio, live: "if I tell you to read a transcript,
 * you read it." The FIRST turn already reads the call transcript
 * automatically (fetchCallContext, called unconditionally by
 * handleFirstTurn); a follow-up conversational turn had no way to re-check
 * it even when explicitly asked. This pins the fix: fetchCallContext() is
 * shared between both call sites, and findRelevantCallContext() only pays
 * for the lookup when the instruction actually needs it — degrading to "no
 * context" on anything unresolved or any failure, never throwing into the
 * caller, same shape as the sibling email lookup
 * (narrative-email-context.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  callRow: null as { meeting_name?: string; created_at?: string; notes?: string; transcript?: unknown } | null,
  callError: null as { message: string } | null,
  classifyResponse: '{"needs_call": false}',
  throwOnClassify: false,
  eqCalls: [] as Array<{ column: string; value: unknown }>,
}))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        order: vi.fn(() => ({
          limit: vi.fn(() => ({
            eq: vi.fn((column: string, value: unknown) => {
              h.eqCalls.push({ column, value })
              return { maybeSingle: vi.fn(async () => ({ data: h.callRow, error: h.callError })) }
            }),
          })),
        })),
      })),
    })),
  },
}))

vi.mock('@/lib/portal/ai-provider', () => ({
  callAI: vi.fn(async () => {
    if (h.throwOnClassify) throw new Error('AI provider unavailable')
    return { text: h.classifyResponse }
  }),
}))

import { fetchCallContext, findRelevantCallContext } from '@/lib/offers/narrative-call-context'

beforeEach(() => {
  h.callRow = null
  h.callError = null
  h.classifyResponse = '{"needs_call": false}'
  h.throwOnClassify = false
  h.eqCalls = []
  vi.clearAllMocks()
})

describe('fetchCallContext', () => {
  it('returns "" immediately with neither a lead nor an account id', async () => {
    const result = await fetchCallContext(null, null)
    expect(result).toBe('')
    expect(h.eqCalls).toEqual([])
  })

  it('scopes the query by lead_id when a leadId is given', async () => {
    h.callRow = { notes: 'Client wants a Florida LLC.' }
    await fetchCallContext('lead-1', null)
    expect(h.eqCalls).toEqual([{ column: 'lead_id', value: 'lead-1' }])
  })

  it('scopes the query by account_id when only an accountId is given', async () => {
    h.callRow = { notes: 'Existing client, wants onboarding.' }
    await fetchCallContext(null, 'acct-1')
    expect(h.eqCalls).toEqual([{ column: 'account_id', value: 'acct-1' }])
  })

  it('renders the call notes when a row is found', async () => {
    h.callRow = { notes: 'Client wants a Florida LLC.', meeting_name: 'Intro call' }
    const result = await fetchCallContext('lead-1', null)
    expect(result).toContain('Client wants a Florida LLC.')
  })

  it('returns "" when no call row is found', async () => {
    h.callRow = null
    const result = await fetchCallContext('lead-1', null)
    expect(result).toBe('')
  })

  it('returns "" instead of throwing on a query error', async () => {
    h.callError = { message: 'db down' }
    const result = await fetchCallContext('lead-1', null)
    expect(result).toBe('')
  })
})

describe('findRelevantCallContext', () => {
  it('returns undefined immediately with neither a lead nor an account id — never calls the AI', async () => {
    const result = await findRelevantCallContext('read the transcript', null, null)
    expect(result).toBeUndefined()
  })

  it('skips the call lookup entirely when the classifier says none is needed', async () => {
    h.classifyResponse = '{"needs_call": false}'
    h.callRow = { notes: 'Should never be read.' }
    const result = await findRelevantCallContext('shorten the intro', 'lead-1', null)
    expect(result).toBeUndefined()
    expect(h.eqCalls).toEqual([]) // fetchCallContext was never even invoked
  })

  it('fetches and returns the call context when the classifier says it is needed', async () => {
    h.classifyResponse = '{"needs_call": true}'
    h.callRow = { notes: 'He specifically asked for a Wyoming LLC, not Florida.' }
    const result = await findRelevantCallContext('read the transcript, what state did he actually ask for?', 'lead-1', null)
    expect(result).toContain('Wyoming LLC')
  })

  it('returns undefined when the classifier says yes but no call is on file', async () => {
    h.classifyResponse = '{"needs_call": true}'
    h.callRow = null
    const result = await findRelevantCallContext('read the transcript', 'lead-1', null)
    expect(result).toBeUndefined()
  })

  it('degrades to no context, never throwing, when the classifier call fails', async () => {
    h.throwOnClassify = true
    const result = await findRelevantCallContext('read the transcript', 'lead-1', null)
    expect(result).toBeUndefined()
  })

  it('degrades to no context, never throwing, when the classifier returns unparseable JSON', async () => {
    h.classifyResponse = 'sorry, I cannot help with that'
    const result = await findRelevantCallContext('read the transcript', 'lead-1', null)
    expect(result).toBeUndefined()
  })
})
