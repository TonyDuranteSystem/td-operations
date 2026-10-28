/**
 * The default document type a workspace stage's upload box carries (stage_layout.documentType) — what the server applies when a request sent no
 * type (a stale browser tab, a direct call), so a typed box can never save a file as the generic "Other document" (dev job e3215801).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fx = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  error: false,
  filters: [] as Array<[string, unknown]>,
}))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== 'pipeline_stages') throw new Error(`unexpected table ${table}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      b.select = () => b
      b.eq = (c: string, v: unknown) => { fx.filters.push([c, v]); return b }
      b.limit = async () => (fx.error ? { data: null, error: { message: 'boom' } } : { data: fx.rows, error: null })
      return b
    },
  },
}))

import { boxDefaultType } from '@/lib/flows/flow-upload-type'

const layout = (components: unknown[]) => ({ stage_layout: { components } })
beforeEach(() => { fx.rows = []; fx.error = false; fx.filters = [] })

describe('boxDefaultType', () => {
  it('one typed upload box -> its type (and it is looked up by service type AND stage name)', async () => {
    fx.rows = [layout([{ type: 'info_panel' }, { type: 'document_upload', label: 'Upload CP565', documentType: 'itin_letter' }])]
    expect(await boxDefaultType('ITIN', 'ITIN Approved')).toBe('itin_letter')
    expect(fx.filters).toContainEqual(['service_type', 'ITIN'])
    expect(fx.filters).toContainEqual(['stage_name', 'ITIN Approved'])
  })
  it('an untyped box (a workspace not moved over yet) -> null: the upload stays as before', async () => {
    fx.rows = [layout([{ type: 'document_upload', label: 'Upload Articles' }])]
    expect(await boxDefaultType('Company Formation', 'Filed with State')).toBeNull()
  })
  it('no upload box at all -> null', async () => {
    fx.rows = [layout([{ type: 'info_panel' }])]
    expect(await boxDefaultType('ITIN', 'Data Collection')).toBeNull()
  })
  it('two boxes with DIFFERENT types, or one typed and one not -> null (never guess)', async () => {
    fx.rows = [layout([{ type: 'document_upload', documentType: 'receipt' }, { type: 'document_upload', documentType: 'itin_letter' }])]
    expect(await boxDefaultType('ITIN', 'X')).toBeNull()
    fx.rows = [layout([{ type: 'document_upload', documentType: 'receipt' }, { type: 'document_upload' }])]
    expect(await boxDefaultType('ITIN', 'X')).toBeNull()
  })
  it('two boxes with the SAME type -> that type', async () => {
    fx.rows = [layout([{ type: 'document_upload', documentType: 'receipt' }, { type: 'document_upload', documentType: 'receipt' }])]
    expect(await boxDefaultType('ITIN', 'X')).toBe('receipt')
  })
  it('unknown stage, unreadable layout, or a database error -> null (never blocks, the request\'s own type is still checked)', async () => {
    expect(await boxDefaultType('ITIN', 'Nope')).toBeNull()
    fx.rows = [{ stage_layout: 'not json' }]
    expect(await boxDefaultType('ITIN', 'X')).toBeNull()
    fx.error = true
    expect(await boxDefaultType('ITIN', 'X')).toBeNull()
  })
  it('no service type or stage name -> null without asking', async () => {
    expect(await boxDefaultType(null, 'X')).toBeNull()
    expect(await boxDefaultType('ITIN', null)).toBeNull()
    expect(fx.filters).toEqual([])
  })
})
