/**
 * Dev job e3215801 — the document type of a WORKSPACE upload follows the Storage rule: the type must exist in the catalog (active), belong to
 * that kind of storage, and never be staff-only when the client will see the file. No type sent = unchanged behaviour. Fails closed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fx = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  error: false,
  filters: [] as Array<[string, unknown]>,
}))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      b.select = () => b
      b.eq = (c: string, v: unknown) => { fx.filters.push([c, v]); return b }
      b.maybeSingle = async () => (fx.error ? { data: null, error: { message: 'boom' } } : { data: fx.row, error: null })
      return b
    },
  },
}))

import { resolveFlowUploadType } from '@/lib/flows/flow-upload-type'

beforeEach(() => { fx.row = { slug: 'itin_letter', metadata: { personal: true } }; fx.error = false; fx.filters = [] })
const base = { ownerKind: 'person' as const, visibleToClient: true, folderKind: 'itin' }

describe('resolveFlowUploadType', () => {
  it('no type sent but the box has a default -> the default is checked like any chosen type (a stale tab can never save "Other document")', async () => {
    expect(await resolveFlowUploadType({ ...base, slug: undefined, fallbackSlug: 'itin_letter' })).toEqual({ ok: true, slug: 'itin_letter' })
    expect(fx.filters).toContainEqual(['slug', 'itin_letter'])
  })
  it('the box default is NOT usable (not in the catalog / not for this storage) -> refused with a "reload the page" sentence', async () => {
    fx.row = null
    const r = await resolveFlowUploadType({ ...base, slug: '', fallbackSlug: 'itin_application' })
    expect(r).toEqual({ ok: false, error: 'This upload needs a document type — please reload the page and choose one from the list.' })
  })
  it('a type WAS sent: the box default is ignored (the sent type is the one checked)', async () => {
    expect(await resolveFlowUploadType({ ...base, slug: 'itin_letter', fallbackSlug: 'receipt' })).toEqual({ ok: true, slug: 'itin_letter' })
    expect(fx.filters).toContainEqual(['slug', 'itin_letter'])
    expect(fx.filters).not.toContainEqual(['slug', 'receipt'])
  })
  it('no type sent (a box without a picker) -> null, nothing is read: the upload behaves exactly as before', async () => {
    for (const slug of [undefined, null, '']) expect(await resolveFlowUploadType({ ...base, slug })).toEqual({ ok: true, slug: null })
    expect(fx.filters).toEqual([])
  })
  it('a catalogued active type that belongs here -> accepted (and only an ACTIVE catalog row of the storage list is asked for)', async () => {
    expect(await resolveFlowUploadType({ ...base, slug: 'itin_letter' })).toEqual({ ok: true, slug: 'itin_letter' })
    expect(fx.filters).toContainEqual(['catalog_id', 'storage_document_types'])
    expect(fx.filters).toContainEqual(['status', 'active'])
    expect(fx.filters).toContainEqual(['slug', 'itin_letter'])
  })
  it('a type that is not in the list (or not a string) is refused with the Storage sentence', async () => {
    fx.row = null
    expect(await resolveFlowUploadType({ ...base, slug: 'made_up' })).toEqual({ ok: false, error: 'Choose a document type from the list.' })
    expect(await resolveFlowUploadType({ ...base, slug: 42 })).toEqual({ ok: false, error: 'Choose a document type from the list.' })
  })
  it('a person\'s paper does not belong in a COMPANY storage — and a company paper is fine in a person\'s', async () => {
    const r = await resolveFlowUploadType({ ...base, ownerKind: 'company', slug: 'itin_letter' })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('does not belong in this storage')
    fx.row = { slug: 'articles', metadata: { personal: false } }
    expect((await resolveFlowUploadType({ ...base, ownerKind: 'person', slug: 'articles' })).ok).toBe(true)
  })
  it('a STAFF-ONLY type is refused when the client will see the file, allowed when it stays internal', async () => {
    fx.row = { slug: 'formation_summary', metadata: { personal: false, staff_only: true } }
    const r = await resolveFlowUploadType({ ...base, ownerKind: 'company', slug: 'formation_summary', visibleToClient: true })
    expect(r.ok === false && r.error).toContain('staff only')
    expect((await resolveFlowUploadType({ ...base, ownerKind: 'company', slug: 'formation_summary', visibleToClient: false })).ok).toBe(true)
  })
  it('FAILS CLOSED: a catalog that cannot be read refuses the upload ("nothing was uploaded")', async () => {
    fx.error = true
    const r = await resolveFlowUploadType({ ...base, slug: 'itin_letter' })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('nothing was uploaded')
  })
})
