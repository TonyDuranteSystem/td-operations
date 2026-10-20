import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The stage name a CLIENT reads in a push / stage email (lib/service-delivery.ts). A name change shows its
 * client label (its internal step names are staff wording, and one used to carry a typo); every other
 * service keeps today's wording. The portal notification already used the client label for everyone.
 */

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock('@/lib/db', () => ({ dbWrite: vi.fn(), dbWriteSafe: vi.fn() }))
vi.mock('@/lib/mcp/action-log', () => ({ logAction: vi.fn() }))
vi.mock('@/lib/operations/formation-materialize', () => ({ preflightFormationMaterialization: vi.fn(), materializeFormationCompany: vi.fn() }))

import { clientStageLabelFor, usesClientStageWording } from '@/lib/service-delivery'
import { supabaseAdmin } from '@/lib/supabase-admin'

let language: string | null = null
let lookups = 0
beforeEach(() => {
  language = null
  lookups = 0
  vi.mocked(supabaseAdmin.from).mockImplementation((() => {
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.eq = () => c
    c.maybeSingle = () => { lookups++; return Promise.resolve({ data: language === null ? null : { language }, error: null }) }
    return c
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any)
})

describe('usesClientStageWording', () => {
  it('only a name change reads the client label in the push and the stage email', () => {
    expect(usesClientStageWording('Company Change Name')).toBe(true)
    for (const t of ['Tax Return', 'ITIN', 'Company Formation', 'Company Closure', '', null, undefined]) expect(usesClientStageWording(t as never)).toBe(false)
  })
})

describe('clientStageLabelFor', () => {
  const stage = { stage_name: 'Check names and client confirms', client_label: 'We check the names and you confirm one', client_label_it: 'Verifichiamo i nomi e tu ne confermi uno' }

  it('uses the English client label by default', async () => {
    language = 'English'
    expect(await clientStageLabelFor(stage, 'c-1')).toEqual({ label: 'We check the names and you confirm one', hasClientLabel: true })
  })

  it('uses the Italian label for an Italian contact (free-text language)', async () => {
    language = 'Italiano'
    expect((await clientStageLabelFor(stage, 'c-1')).label).toBe('Verifichiamo i nomi e tu ne confermi uno')
  })

  it('falls back to the internal name when there is no client label', async () => {
    const r = await clientStageLabelFor({ stage_name: 'Waiting for the state' }, 'c-1')
    expect(r).toEqual({ label: 'Waiting for the state', hasClientLabel: false })
    expect(lookups).toBe(0)
  })

  it('needs no contact lookup without a contact or an Italian label', async () => {
    expect((await clientStageLabelFor(stage, null)).label).toBe('We check the names and you confirm one')
    expect((await clientStageLabelFor({ stage_name: 'X', client_label: 'Y' }, 'c-1')).label).toBe('Y')
    expect(lookups).toBe(0)
  })

  it('a failed language lookup keeps the English label', async () => {
    vi.mocked(supabaseAdmin.from).mockImplementation((() => { throw new Error('db down') }) as never)
    expect((await clientStageLabelFor(stage, 'c-1')).label).toBe('We check the names and you confirm one')
  })
})
