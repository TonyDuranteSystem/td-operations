import { describe, it, expect } from 'vitest'
import { BULK_DELETE_MAX, inScope, parseBulkDeleteIds, planBulkDelete, type BulkDeleteRow, type BulkDeleteScope } from '@/lib/portal/bulk-delete-messages'
import { chooseFlowMessageTopic } from '@/lib/flows/flow-chat-topic'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const row = (n: number, over: Partial<BulkDeleteRow> = {}): BulkDeleteRow => ({ id: id(n), account_id: 'acc-1', contact_id: 'c-1', deleted_at: null, ...over })

describe('parseBulkDeleteIds', () => {
  it('accepts a list and removes duplicates', () => {
    expect(parseBulkDeleteIds([id(1), id(2), id(1)])).toEqual({ ok: true, ids: [id(1), id(2)] })
  })
  it('lowercases ids so an upper-case copy of the same id is not a second, missing message', () => {
    expect(parseBulkDeleteIds([id(1).toUpperCase(), id(1)])).toEqual({ ok: true, ids: [id(1)] })
  })
  it('rejects empty, non-list, bad ids and too many', () => {
    expect(parseBulkDeleteIds([]).ok).toBe(false)
    expect(parseBulkDeleteIds('x').ok).toBe(false)
    expect(parseBulkDeleteIds([id(1), 'not-an-id']).ok).toBe(false)
    expect(parseBulkDeleteIds([id(1), 5]).ok).toBe(false)
    const many = Array.from({ length: BULK_DELETE_MAX + 1 }, (_, i) => id(i + 1))
    expect(parseBulkDeleteIds(many).ok).toBe(false)
    expect(parseBulkDeleteIds(many.slice(0, BULK_DELETE_MAX)).ok).toBe(true)
  })
})

describe('planBulkDelete', () => {
  const acct: BulkDeleteScope = { kind: 'account', accountId: 'acc-1' }
  const person: BulkDeleteScope = { kind: 'contact', contactId: 'c-1', linkedAccountIds: ['acc-1', 'acc-2'] }

  it("deletes the live messages of the open company's chat and counts the already-deleted ones", () => {
    const p = planBulkDelete([id(1), id(2), id(3)], [row(1), row(2, { deleted_at: '2026-10-01' }), row(3)], acct)
    expect(p).toEqual({ ok: true, toDelete: [id(1), id(3)], alreadyDeleted: 1 })
  })
  it('refuses a message of another company (could hide it from the wrong client)', () => {
    const p = planBulkDelete([id(1), id(2)], [row(1), row(2, { account_id: 'acc-2' })], acct)
    expect(p).toMatchObject({ ok: false, status: 400 })
  })
  it("a company chat does not include the person's own personal messages", () => {
    const p = planBulkDelete([id(1), id(2)], [row(1), row(2, { account_id: null })], acct)
    expect(p).toMatchObject({ ok: false, status: 400 })
  })
  it("a person's unified thread covers their own messages and those of their companies", () => {
    const p = planBulkDelete([id(1), id(2), id(3)], [row(1, { account_id: null }), row(2, { account_id: 'acc-2' }), row(3, { account_id: 'acc-1' })], person)
    expect(p).toMatchObject({ ok: true })
  })
  it("a person's thread refuses a message of a company they do not belong to", () => {
    const p = planBulkDelete([id(1), id(2)], [row(1, { account_id: 'acc-1' }), row(2, { account_id: 'acc-9', contact_id: 'someone-else' })], person)
    expect(p).toMatchObject({ ok: false, status: 400 })
  })
  it('a missing message stops the whole request', () => {
    expect(planBulkDelete([id(1), id(9)], [row(1)], acct)).toMatchObject({ ok: false, status: 404 })
  })
  it('inScope: a company message with someone else as sender still belongs to the company chat', () => {
    expect(inScope({ account_id: 'acc-1', contact_id: 'other' }, acct)).toBe(true)
    expect(inScope({ account_id: null, contact_id: 'c-1' }, person)).toBe(true)
    expect(inScope({ account_id: null, contact_id: 'c-2' }, person)).toBe(false)
  })
})

describe('chooseFlowMessageTopic (Calendar Message client)', () => {
  it('no choice = the job topic', () => {
    expect(chooseFlowMessageTopic({ requested: undefined, defaultTopic: 'ITIN', existing: ['Tax'] })).toBe('ITIN')
    expect(chooseFlowMessageTopic({ requested: '   ', defaultTopic: 'ITIN', existing: [] })).toBe('ITIN')
    expect(chooseFlowMessageTopic({ requested: undefined, defaultTopic: null, existing: [] })).toBeNull()
  })
  it('an existing topic keeps its own spelling, whatever the case or spaces typed', () => {
    expect(chooseFlowMessageTopic({ requested: ' itin ', defaultTopic: 'ITIN', existing: [] })).toBe('ITIN')
    expect(chooseFlowMessageTopic({ requested: 'documents', defaultTopic: 'ITIN', existing: ['Documents'] })).toBe('Documents')
  })
  it('a new name is created, trimmed and capped at 100 characters', () => {
    expect(chooseFlowMessageTopic({ requested: ' Passport copy ', defaultTopic: 'ITIN', existing: [] })).toBe('Passport copy')
    expect(chooseFlowMessageTopic({ requested: 'x'.repeat(150), defaultTopic: null, existing: [] })).toHaveLength(100)
  })
  it('a non-text topic is ignored', () => {
    expect(chooseFlowMessageTopic({ requested: 42, defaultTopic: 'ITIN', existing: [] })).toBe('ITIN')
  })
})
