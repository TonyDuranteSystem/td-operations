import { beforeEach, describe, expect, it, vi } from 'vitest'

type R = { data: unknown; error: { message: string } | null; count?: number | null }
const state = vi.hoisted(() => ({
  updateResult: { data: null, error: null } as R,
  selectResult: { data: null, error: null } as R,
  countResult: { data: null, error: null, count: 0 } as R,
  patches: [] as unknown[],
  filters: [] as Array<[string, unknown]>,
  countFilters: [] as Array<[string, unknown]>,
}))

vi.mock('@/lib/catalog/framework', () => ({ getEntryById: async () => null, updateMetadata: vi.fn() }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => ({
      update: (patch: unknown) => {
        state.patches.push(patch)
        const chain = { eq: (c: string, v: unknown) => { state.filters.push([c, v]); return chain }, select: () => ({ maybeSingle: async () => state.updateResult }) }
        return chain
      },
      select: (_cols: string, opts?: { head?: boolean }) => {
        if (opts?.head) {
          // a count query: every .eq() is recorded and the chain can be awaited at any point
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const head: any = {
            eq: (c: string, v: unknown) => { state.countFilters.push([c, v]); return head },
            neq: (c: string, v: unknown) => { state.countFilters.push([`!${c}`, v]); return head },
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(state.countResult).then(res, rej),
          }
          return head
        }
        const chain: Record<string, unknown> = {
          eq: (c: string, v: unknown) => { state.filters.push([c, v]); return chain },
          maybeSingle: async () => state.selectResult,
        }
        return chain
      },
    }),
  },
}))

import { saveDraft, offersSentByVersion, getOpenDraft } from '@/lib/contracts/service-contract-texts'

const good = {
  title: 'T', shortTitle: 'T', pdfPrefix: 'T_Agreement',
  scope: { intro: 'i', items: ['a'], closing: 'c' }, procedure: { intro: 'p', steps: [{ title: 's', desc: 'd' }] },
  commitments: ['c1'], clientDuties: { intro: 'd', items: [{ bold: 'b', rest: ' r' }] }, signatureText: 'sig', successNote: 'ok', workPhrase: 'the work', liabilityPhrase: 'delays',
}

beforeEach(() => {
  state.updateResult = { data: { id: 'd1', status: 'draft', content_hash: 'h2' }, error: null }
  state.selectResult = { data: null, error: null }
  state.countResult = { data: null, error: null, count: 0 }
  state.patches.length = 0; state.filters.length = 0; state.countFilters.length = 0
})

describe('saveDraft', () => {
  it('only touches an OPEN draft, and — with the fingerprint the caller read — only if it is still that one', async () => {
    await saveDraft({ id: 'd1', content: good, source: 'manual', expectedHash: 'h1' })
    expect(state.filters).toEqual([['id', 'd1'], ['status', 'draft'], ['content_hash', 'h1']])
    expect(state.patches[0]).toMatchObject({ source: 'manual' })
  })
  it('without a fingerprint it does not compare', async () => {
    await saveDraft({ id: 'd1', content: good })
    expect(state.filters.map((f) => f[0])).toEqual(['id', 'status'])
  })
  it('a draft changed elsewhere says so; a closed one says it is no longer open', async () => {
    state.updateResult = { data: null, error: null }
    state.selectResult = { data: { id: 'd1', status: 'draft' }, error: null }
    await expect(saveDraft({ id: 'd1', content: good, expectedHash: 'old' })).rejects.toMatchObject({ code: 'DRAFT_CHANGED' })
    state.selectResult = { data: { id: 'd1', status: 'approved' }, error: null }
    await expect(saveDraft({ id: 'd1', content: good, expectedHash: 'old' })).rejects.toMatchObject({ code: 'NOT_A_DRAFT' })
    await expect(saveDraft({ id: 'd1', content: good })).rejects.toMatchObject({ code: 'NOT_A_DRAFT' })
  })
  it('refuses invalid wording before any write', async () => {
    await expect(saveDraft({ id: 'd1', content: { ...good, successNote: '<b>' } })).rejects.toMatchObject({ code: 'INVALID_WORDING' })
    expect(state.patches).toHaveLength(0)
  })
})

describe('a database without the migration', () => {
  it('is reported as "not switched on yet", not as a crash', async () => {
    for (const m of ['relation "public.service_contract_texts" does not exist', 'Could not find the table \'public.service_contract_texts\' in the schema cache', 'Could not find the function public.approve_service_contract_text']) {
      state.selectResult = { data: null, error: { message: m } }
      await expect(getOpenDraft('e1')).rejects.toMatchObject({ code: 'NOT_READY' })
    }
  })
})

describe('offersSentByVersion', () => {
  it('counts the offers that carry each version — matching the version number AND its fingerprint, under the contract type', async () => {
    state.countResult = { data: null, error: null, count: 3 }
    const out = await offersSentByVersion('custom_apostille', [{ version: 1, hash: 'h1' }, { version: 2, hash: 'h1' }])
    expect(out).toEqual({ 1: 3, 2: 3 })
    expect(state.countFilters.map((f) => f[0]).sort()).toEqual([
      '!status', '!status',
      'contract_texts->custom_apostille->>hash', 'contract_texts->custom_apostille->>hash',
      'contract_texts->custom_apostille->>version', 'contract_texts->custom_apostille->>version',
    ])
    // an offer that is still a draft (or only previewed) has not been SENT with this wording
    expect(state.countFilters.filter((f) => f[0] === '!status').every((f) => f[1] === 'draft')).toBe(true)
    expect(state.countFilters.filter((f) => String(f[0]).endsWith('version')).map((f) => f[1]).sort()).toEqual(['1', '2'])
  })
  it('a null count is 0, and a type that is not a stored contract asks nothing', async () => {
    state.countResult = { data: null, error: null, count: null }
    expect(await offersSentByVersion('custom_apostille', [{ version: 1, hash: 'h1' }])).toEqual({ 1: 0 })
    state.countFilters.length = 0
    expect(await offersSentByVersion('shipping', [{ version: 1, hash: 'h1' }])).toEqual({})
    expect(state.countFilters).toHaveLength(0)
  })
})
