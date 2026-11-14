import { describe, it, expect, beforeEach, vi } from 'vitest'
import { writeBecameClientHow } from '@/lib/operations/account-became-client'

type Call = { table: string; op: string; payload?: unknown; filters: Array<[string, string, unknown]> }
const calls: Call[] = []
const scripts: Record<string, unknown> = {}

function from(table: string) {
  const call: Call = { table, op: 'select', filters: [] }
  const done = () => {
    calls.push(call)
    const s = scripts[`${table}.${call.op}`]
    return Promise.resolve(s ?? { data: null, error: null })
  }
  const chain: Record<string, unknown> = {
    select: () => chain,
    update: (p: unknown) => { call.op = 'update'; call.payload = p; return chain },
    insert: (p: unknown) => { call.op = 'insert'; call.payload = p; return done() },
    eq: (c: string, v: unknown) => { call.filters.push(['eq', c, v]); return chain },
    is: (c: string, v: unknown) => { call.filters.push(['is', c, v]); return chain },
    maybeSingle: () => done(),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => done().then(resolve, reject),
  }
  return chain
}
const db = { from }
const ID = 'acc-1'
const actor = 'dashboard:antonio.durante'
const account = (over: Record<string, unknown> = {}) => ({
  data: { id: ID, company_name: '2L Consulting LLC', became_client_how: 'onboarded', updated_at: 'U1', ...over },
  error: null,
})
const calls_ = (table: string, op: string) => calls.filter((c) => c.table === table && c.op === op)

beforeEach(() => {
  calls.length = 0
  for (const k of Object.keys(scripts)) delete scripts[k]
  scripts['accounts.select'] = account()
  scripts['accounts.update'] = { data: [{ id: ID }], error: null }
  scripts['action_log.insert'] = { error: null }
})

describe('changing the answer', () => {
  it('saves the new value, stamps who and when, matched on the updated_at the person saw', async () => {
    const r = await writeBecameClientHow(db, { accountId: ID, mode: 'change', value: 'formed_by_us', expectedUpdatedAt: 'U1', actor })
    expect(r).toEqual({ success: true, value: 'formed_by_us' })
    const [u] = calls_('accounts', 'update')
    expect(u.payload).toMatchObject({ became_client_how: 'formed_by_us', became_client_how_checked_by: actor })
    expect((u.payload as { became_client_how_checked_at: string }).became_client_how_checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(u.filters).toContainEqual(['eq', 'id', ID])
    expect(u.filters).toContainEqual(['eq', 'updated_at', 'U1'])
    // nothing else on the account is written
    expect(Object.keys(u.payload as object).sort()).toEqual(['became_client_how', 'became_client_how_checked_at', 'became_client_how_checked_by'])
  })

  it('writes the old and the new value to the audit log', async () => {
    await writeBecameClientHow(db, { accountId: ID, mode: 'change', value: 'formed_by_us', expectedUpdatedAt: 'U1', actor })
    const [log] = calls_('action_log', 'insert')
    expect(log.payload).toMatchObject({
      actor,
      action_type: 'account_became_client_how_set',
      table_name: 'accounts',
      record_id: ID,
      details: { from: 'onboarded', to: 'formed_by_us', mode: 'change', by: actor },
    })
    expect((log.payload as { summary: string }).summary).toBe('How 2L Consulting LLC became our client changed: Onboarded -> Formed by us')
  })

  it('refuses a value that is not one of the two answers, before writing anything', async () => {
    for (const value of ['formed', '', null, undefined, 'ONBOARDED']) {
      const r = await writeBecameClientHow(db, { accountId: ID, mode: 'change', value: value as never, expectedUpdatedAt: 'U1', actor })
      expect(r).toEqual({ success: false, error: 'Choose Formed by us or Onboarded.' })
    }
    expect(calls_('accounts', 'update').length).toBe(0)
  })

  it('a company with no answer yet can be set (from "Not set")', async () => {
    scripts['accounts.select'] = account({ became_client_how: null })
    const r = await writeBecameClientHow(db, { accountId: ID, mode: 'change', value: 'onboarded', expectedUpdatedAt: 'U1', actor })
    expect(r.success).toBe(true)
    expect((calls_('action_log', 'insert')[0].payload as { summary: string }).summary).toMatch(/Not set -> Onboarded/)
  })
})

describe('confirming a guess ("It\'s correct")', () => {
  it('keeps the value, stamps who and when, and logs it as a confirmation', async () => {
    const r = await writeBecameClientHow(db, { accountId: ID, mode: 'confirm', expectedUpdatedAt: 'U1', actor })
    expect(r).toEqual({ success: true, value: 'onboarded' })
    expect(calls_('accounts', 'update')[0].payload).toMatchObject({ became_client_how: 'onboarded', became_client_how_checked_by: actor })
    const [log] = calls_('action_log', 'insert')
    expect((log.payload as { action_type: string }).action_type).toBe('account_became_client_how_confirmed')
    expect((log.payload as { summary: string }).summary).toBe('How 2L Consulting LLC became our client confirmed: Onboarded')
  })

  it('refuses to confirm when there is nothing to confirm', async () => {
    scripts['accounts.select'] = account({ became_client_how: null })
    const r = await writeBecameClientHow(db, { accountId: ID, mode: 'confirm', expectedUpdatedAt: 'U1', actor })
    expect(r).toEqual({ success: false, error: 'Choose Formed by us or Onboarded first.' })
    expect(calls_('accounts', 'update').length).toBe(0)
  })
})

describe('when something goes wrong', () => {
  it('says plainly when someone else changed the company in the meantime, and logs nothing', async () => {
    scripts['accounts.update'] = { data: [], error: null }
    const r = await writeBecameClientHow(db, { accountId: ID, mode: 'change', value: 'formed_by_us', expectedUpdatedAt: 'OLD', actor })
    expect(r).toMatchObject({ success: false })
    expect((r as { error: string }).error).toMatch(/updated since the page loaded/)
    expect(calls_('action_log', 'insert').length).toBe(0)
  })

  it('a company that never had an updated_at is matched on null', async () => {
    await writeBecameClientHow(db, { accountId: ID, mode: 'change', value: 'formed_by_us', expectedUpdatedAt: null, actor })
    expect(calls_('accounts', 'update')[0].filters).toContainEqual(['is', 'updated_at', null])
  })

  it('surfaces the real cause of a failed read or write', async () => {
    scripts['accounts.select'] = { data: null, error: { message: 'timeout' } }
    expect(await writeBecameClientHow(db, { accountId: ID, mode: 'change', value: 'formed_by_us', expectedUpdatedAt: 'U1', actor })).toEqual({
      success: false,
      error: 'Could not read the company: timeout',
    })
    scripts['accounts.select'] = account()
    scripts['accounts.update'] = { data: null, error: { message: 'trigger said no' } }
    const r = await writeBecameClientHow(db, { accountId: ID, mode: 'change', value: 'formed_by_us', expectedUpdatedAt: 'U1', actor })
    expect(r).toEqual({ success: false, error: 'Could not save: trigger said no' })
  })

  it('says the company was not found', async () => {
    scripts['accounts.select'] = { data: null, error: null }
    expect(await writeBecameClientHow(db, { accountId: ID, mode: 'change', value: 'onboarded', expectedUpdatedAt: 'U1', actor })).toEqual({
      success: false,
      error: 'This company was not found.',
    })
  })

  it('a saved answer is never reported as failed when only the history line fails, and the old value goes to the server log', async () => {
    scripts['action_log.insert'] = { error: { message: 'log down' } }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await writeBecameClientHow(db, { accountId: ID, mode: 'change', value: 'formed_by_us', expectedUpdatedAt: 'U1', actor })
    expect(r).toEqual({ success: true, value: 'formed_by_us', warning: 'Saved, but the history line could not be written.' })
    expect(spy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('"from":"onboarded"')
    spy.mockRestore()
  })
})
