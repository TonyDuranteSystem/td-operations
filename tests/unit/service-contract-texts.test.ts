import { beforeEach, describe, expect, it, vi } from 'vitest'

const entry = vi.hoisted(() => ({ value: null as null | { id: string; slug: string; display_name: string; metadata: Record<string, unknown> } }))
const updateMetadata = vi.hoisted(() => vi.fn())
const rpc = vi.hoisted(() => vi.fn())
const insertCalls = vi.hoisted(() => ({ rows: [] as unknown[] }))
const insertResult = vi.hoisted(() => ({ value: { data: { id: 'row1' }, error: null } as { data: unknown; error: { message: string } | null } }))
const clash = vi.hoisted(() => ({ value: { data: [] as unknown[], error: null } as { data: unknown; error: { message: string } | null }, filters: [] as Array<[string, unknown]> }))

vi.mock('@/lib/catalog/framework', () => ({
  getEntryById: async () => entry.value,
  updateMetadata: (...a: unknown[]) => updateMetadata(...a),
}))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: (table: string) => table === 'catalog_entries'
      ? (() => {
          // the "does another service already use this contract type?" lookup
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const chain: any = {
            eq: (c: string, v: unknown) => { clash.filters.push([c, v]); return chain },
            neq: (c: string, v: unknown) => { clash.filters.push([`!${c}`, v]); return chain },
            limit: () => chain,
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(clash.value).then(res, rej),
          }
          return { select: () => chain }
        })()
      : {
          insert: (row: unknown) => { insertCalls.rows.push(row); return { select: () => ({ single: async () => insertResult.value }) } },
        },
  },
}))

import { ContractTextError, approveDraft, createDraft, ensureContractType } from '@/lib/contracts/service-contract-texts'

const ACTOR = { kind: 'ui' as const, userId: 'u1' }
const good = {
  title: 'Apostille Service Agreement', shortTitle: 'Apostille Service Agreement', pdfPrefix: 'Apostille_Agreement',
  scope: { intro: 'i', items: ['a'], closing: 'c' }, procedure: { intro: 'p', steps: [{ title: 's', desc: 'd' }] },
  commitments: ['c1'], clientDuties: { intro: 'd', items: [{ bold: 'b', rest: 'r' }] }, signatureText: 'sig', successNote: 'ok', workPhrase: 'the work', liabilityPhrase: 'delays',
}

beforeEach(() => {
  entry.value = { id: 'e1', slug: 'apostille', display_name: 'Apostille', metadata: { pipeline: 'Apostille' } }
  updateMetadata.mockReset(); rpc.mockReset(); insertCalls.rows.length = 0
  clash.value = { data: [], error: null }; clash.filters.length = 0
  insertResult.value = { data: { id: 'row1' }, error: null }
})

describe('ensureContractType — the service carries its own contract type', () => {
  it('a service with none gets custom_<slug>, written through the catalog helper (with a reason)', async () => {
    expect(await ensureContractType('e1', ACTOR)).toBe('custom_apostille')
    expect(updateMetadata).toHaveBeenCalledTimes(1)
    const [id, meta, reason, actor] = updateMetadata.mock.calls[0]
    expect(id).toBe('e1')
    expect(meta).toEqual({ pipeline: 'Apostille', contract_type: 'custom_apostille' })
    expect(String(reason).length).toBeGreaterThan(10)
    expect(actor).toBe(ACTOR)
  })
  it('refuses a type that ANOTHER service already uses (two services must never share one contract)', async () => {
    clash.value = { data: [{ id: 'other', display_name: 'Apostille 2' }], error: null }
    await expect(ensureContractType('e1', ACTOR)).rejects.toMatchObject({ code: 'TYPE_IN_USE' })
    expect(updateMetadata).not.toHaveBeenCalled()
    expect(clash.filters).toEqual([['catalog_id', 'services'], ['metadata->>contract_type', 'custom_apostille'], ['!id', 'e1']])
  })
  it('a custom type typed by hand (not the one its own slug gives) is refused', async () => {
    entry.value!.metadata.contract_type = 'custom_something_else'
    await expect(ensureContractType('e1', ACTOR)).rejects.toMatchObject({ code: 'TYPE_IN_USE' })
    expect(updateMetadata).not.toHaveBeenCalled()
  })
  it('a service that already has its custom type is left alone', async () => {
    entry.value!.metadata.contract_type = 'custom_apostille'
    expect(await ensureContractType('e1', ACTOR)).toBe('custom_apostille')
    expect(updateMetadata).not.toHaveBeenCalled()
  })
  it('a service on a BUILT-IN contract is refused: its contract is in code', async () => {
    entry.value!.metadata.contract_type = 'shipping'
    await expect(ensureContractType('e1', ACTOR)).rejects.toMatchObject({ code: 'BUILT_IN_CONTRACT' })
    expect(updateMetadata).not.toHaveBeenCalled()
  })
  it('a service with an unknown (typo) type is refused with the instruction to clear it', async () => {
    entry.value!.metadata.contract_type = 'apostile'
    await expect(ensureContractType('e1', ACTOR)).rejects.toThrow(/not a contract the system knows/)
  })
  it('a missing service is not found', async () => {
    entry.value = null
    await expect(ensureContractType('e1', ACTOR)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('createDraft', () => {
  it('stores validated wording as a draft of the service, with who made it and how', async () => {
    await createDraft({ entryId: 'e1', content: good, source: 'claude_draft', createdBy: 'Claude', actor: ACTOR })
    expect(insertCalls.rows).toHaveLength(1)
    expect(insertCalls.rows[0]).toMatchObject({ service_entry_id: 'e1', contract_type: 'custom_apostille', source: 'claude_draft', created_by: 'Claude', note: null })
  })
  it('refuses invalid wording BEFORE touching the catalog or the store, and lists what is wrong', async () => {
    const err = await createDraft({ entryId: 'e1', content: { ...good, successNote: '<script>' }, source: 'manual', createdBy: 'a', actor: ACTOR }).catch((e) => e)
    expect(err).toBeInstanceOf(ContractTextError)
    expect(err.code).toBe('INVALID_WORDING')
    expect(err.details.join(' ')).toContain('Message after signing')
    expect(updateMetadata).not.toHaveBeenCalled()
    expect(insertCalls.rows).toHaveLength(0)
  })
  it('a second open draft is reported in plain words', async () => {
    insertResult.value = { data: null, error: { message: 'duplicate key value violates unique constraint "service_contract_texts_one_draft"' } }
    await expect(createDraft({ entryId: 'e1', content: good, source: 'manual', createdBy: 'a', actor: ACTOR })).rejects.toMatchObject({ code: 'DRAFT_EXISTS' })
  })
})

describe('approveDraft — atomic in the database, bound to what was read', () => {
  it('calls the approve function with the draft, the fingerprint that was read and the approver', async () => {
    rpc.mockResolvedValue({ data: { id: 'd1', status: 'approved' }, error: null })
    const row = await approveDraft({ id: 'd1', expectedHash: 'abc', approvedBy: 'antonio.durante@tonydurante.us' })
    expect(rpc).toHaveBeenCalledWith('approve_service_contract_text', { p_id: 'd1', p_expected_hash: 'abc', p_approved_by: 'antonio.durante@tonydurante.us' })
    expect(row).toMatchObject({ status: 'approved' })
  })
  it('maps the database refusals to plain messages', async () => {
    const cases: Array<[string, string]> = [
      ['DRAFT_CHANGED: the wording changed after it was read', 'DRAFT_CHANGED'],
      ['NOT_A_DRAFT: only a draft can be approved (this one is approved)', 'NOT_A_DRAFT'],
      ['NO_APPROVER: an approver is required', 'NO_APPROVER'],
      ['NOT_FOUND: no such contract version', 'NOT_FOUND'],
      ['something unexpected', 'DB'],
    ]
    for (const [message, code] of cases) {
      rpc.mockResolvedValue({ data: null, error: { message } })
      await expect(approveDraft({ id: 'd1', expectedHash: 'abc', approvedBy: 'a' }), code).rejects.toMatchObject({ code })
    }
  })
  it('the stale-fingerprint message tells the approver to read the new text', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'DRAFT_CHANGED: x' } })
    await expect(approveDraft({ id: 'd1', expectedHash: 'old', approvedBy: 'a' })).rejects.toThrow(/read the new text before approving/)
  })
})
