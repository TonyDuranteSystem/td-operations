import { describe, it, expect, vi } from 'vitest'
import { reanchorLeadConversations } from '@/lib/team/reanchor-conversations'

/** Build a fake supabase client that records the query chain and returns `result`. */
function fakeClient(result: { data: { id: string }[] | null; error: { message: string } | null }) {
  const calls: Record<string, unknown> = {}
  const chain = {
    update: (values: Record<string, unknown>) => { calls.update = values; return chain },
    eq: (col: string, val: unknown) => { calls[`eq:${col}`] = val; return chain },
    is: (col: string, val: unknown) => { calls[`is:${col}`] = val; return chain },
    select: (_cols: string) => Promise.resolve(result),
  }
  const client = { from: (table: string) => { calls.from = table; return chain } }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls }
}

describe('reanchorLeadConversations', () => {
  it('no-ops when leadId is missing', async () => {
    const { client, calls } = fakeClient({ data: [], error: null })
    const r = await reanchorLeadConversations(null, 'acct-1', client)
    expect(r).toEqual({ moved: 0 })
    expect(calls.from).toBeUndefined() // never touched the DB
  })

  it('no-ops when accountId is missing', async () => {
    const { client, calls } = fakeClient({ data: [], error: null })
    const r = await reanchorLeadConversations('lead-1', undefined, client)
    expect(r).toEqual({ moved: 0 })
    expect(calls.from).toBeUndefined()
  })

  it('moves lead-anchored discussions onto the account', async () => {
    const { client, calls } = fakeClient({ data: [{ id: 't1' }, { id: 't2' }], error: null })
    const r = await reanchorLeadConversations('lead-1', 'acct-1', client)
    expect(r).toEqual({ moved: 2 })
    expect(calls.from).toBe('internal_threads')
    expect(calls.update).toEqual({ account_id: 'acct-1', lead_id: null })
    expect(calls['eq:lead_id']).toBe('lead-1')
    expect(calls['eq:thread_type']).toBe('discussion')
    expect(calls['is:account_id']).toBe(null) // only rows not already on an account
  })

  it('reports zero moved when nothing matched (idempotent re-run)', async () => {
    const { client } = fakeClient({ data: [], error: null })
    const r = await reanchorLeadConversations('lead-1', 'acct-1', client)
    expect(r).toEqual({ moved: 0 })
  })

  it('never throws on a DB error — returns moved:0', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'boom' } })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await reanchorLeadConversations('lead-1', 'acct-1', client)
    expect(r).toEqual({ moved: 0 })
    spy.mockRestore()
  })
})
