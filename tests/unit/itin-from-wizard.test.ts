import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──
vi.mock('@/lib/services', () => ({ getStartAtWizardServiceTypes: vi.fn() }))
vi.mock('@/lib/operations/service-delivery', () => ({ createSD: vi.fn() }))
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))

import { createItinDeliveriesFromWizard } from '@/lib/operations/itin-from-wizard'
import { getStartAtWizardServiceTypes } from '@/lib/services'
import { createSD } from '@/lib/operations/service-delivery'
import { supabaseAdmin } from '@/lib/supabase-admin'

// Per-table chainable mock. Terminal reads resolve to configured values.
// cfg: { pipelineStages, contactFind, contactInsertId, sdDup }
function installFrom(cfg: {
  pipelineStages?: unknown[]
  contactFind?: { id: string } | null
  contactInsertId?: string
  sdDup?: unknown[]
}) {
  const contactInserts: Array<Record<string, unknown>> = []
  const taskInserts: Array<Record<string, unknown>> = []

  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    if (table === 'pipeline_stages') {
      const p = Promise.resolve({ data: cfg.pipelineStages ?? [], error: null })
      const chain: Record<string, unknown> = {
        select: () => chain, eq: () => chain, order: () => chain,
        limit: () => p,
      }
      return chain
    }
    if (table === 'contacts') {
      const chain: Record<string, unknown> = {
        select: () => chain, eq: () => chain, limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: cfg.contactFind ?? null, error: null }),
        insert: (row: Record<string, unknown>) => {
          contactInserts.push(row)
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { id: cfg.contactInsertId ?? 'new-contact' }, error: null }),
            }),
          }
        },
      }
      return chain
    }
    if (table === 'service_deliveries') {
      const p = Promise.resolve({ data: cfg.sdDup ?? [], error: null })
      const chain: Record<string, unknown> = {
        select: () => chain, eq: () => chain, ilike: () => chain, limit: () => p,
      }
      return chain
    }
    if (table === 'tasks') {
      return { insert: (row: Record<string, unknown>) => { taskInserts.push(row); return Promise.resolve({ error: null }) } }
    }
    return { select: () => ({}) }
  }) as never)

  return { contactInserts, taskInserts }
}

const OWNER = 'owner-contact-1'
const LEAD = 'lead-1'

describe('createItinDeliveriesFromWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getStartAtWizardServiceTypes).mockResolvedValue(['ITIN'])
    vi.mocked(createSD).mockImplementation(async (params) => ({
      id: 'sd-' + (params.contact_id ?? 'x'),
      service_type: params.service_type,
    }) as Awaited<ReturnType<typeof createSD>>)
  })

  it('no-op when ITIN is not a start-at-wizard service', async () => {
    vi.mocked(getStartAtWizardServiceTypes).mockResolvedValue([]) // ITIN disabled
    installFrom({})
    const res = await createItinDeliveriesFromWizard({
      contactId: OWNER, leadId: LEAD, offerToken: 'tok',
      submitted: { owner_needs_itin: true, owner_first_name: 'Adam', owner_last_name: 'M' },
    })
    expect(res.created).toBe(0)
    expect(createSD).not.toHaveBeenCalled()
  })

  it('no-op when nobody is flagged for ITIN', async () => {
    installFrom({})
    const res = await createItinDeliveriesFromWizard({
      contactId: OWNER, leadId: LEAD, offerToken: 'tok',
      submitted: { owner_first_name: 'Adam', owner_needs_itin: false },
    })
    expect(res.created).toBe(0)
    expect(createSD).not.toHaveBeenCalled()
  })

  it('owner flagged → creates one contact-scoped ITIN SD on the owner', async () => {
    installFrom({ pipelineStages: [{ stage_order: 0, auto_tasks: [] }] })
    const res = await createItinDeliveriesFromWizard({
      contactId: OWNER, leadId: LEAD, offerToken: 'adam-2026',
      submitted: { owner_needs_itin: 'yes', owner_first_name: 'Adam', owner_last_name: 'Mihaly', owner_email: 'a@x.com' },
    })
    expect(res.created).toBe(1)
    expect(createSD).toHaveBeenCalledTimes(1)
    const call = vi.mocked(createSD).mock.calls[0][0]
    expect(call.service_type).toBe('ITIN')
    expect(call.contact_id).toBe(OWNER)
    expect(call.account_id).toBeNull()
    expect(call.notes).toContain('adam-2026')
  })

  it('new member flagged → find-or-creates contact stamped with lead_id, creates ITIN SD', async () => {
    const { contactInserts } = installFrom({
      pipelineStages: [{ stage_order: 0, auto_tasks: [] }],
      contactFind: null,              // not found → insert
      contactInsertId: 'peter-contact',
    })
    const res = await createItinDeliveriesFromWizard({
      contactId: OWNER, leadId: LEAD, offerToken: 'tok',
      submitted: {
        member_count: 1,
        member_0_member_first_name: 'Peter', member_0_member_last_name: 'Nemeskeri',
        member_0_member_email: 'peter@x.com', member_0_member_needs_itin: true,
      },
    })
    expect(res.created).toBe(1)
    // new contact stamped with origin lead_id
    expect(contactInserts).toHaveLength(1)
    expect(contactInserts[0].lead_id).toBe(LEAD)
    expect(contactInserts[0].email).toBe('peter@x.com')
    // ITIN SD created on the new member contact
    const call = vi.mocked(createSD).mock.calls[0][0]
    expect(call.contact_id).toBe('peter-contact')
  })

  it('existing member contact → reused, NOT re-stamped with lead_id', async () => {
    const { contactInserts } = installFrom({
      pipelineStages: [{ stage_order: 0, auto_tasks: [] }],
      contactFind: { id: 'hamza-existing' }, // found → reuse, no insert
    })
    const res = await createItinDeliveriesFromWizard({
      contactId: OWNER, leadId: LEAD, offerToken: 'tok',
      submitted: {
        member_count: 1,
        member_0_member_first_name: 'Hamza', member_0_member_email: 'hamza@x.com',
        member_0_member_needs_itin: true,
      },
    })
    expect(res.created).toBe(1)
    expect(contactInserts).toHaveLength(0) // never inserted → never re-stamped
    expect(vi.mocked(createSD).mock.calls[0][0].contact_id).toBe('hamza-existing')
  })

  it('idempotent — skips a person who already has an ITIN SD for this offer', async () => {
    installFrom({ pipelineStages: [{ stage_order: 0, auto_tasks: [] }], sdDup: [{ id: 'existing-sd' }] })
    const res = await createItinDeliveriesFromWizard({
      contactId: OWNER, leadId: LEAD, offerToken: 'tok',
      submitted: { owner_needs_itin: true, owner_first_name: 'Adam', owner_email: 'a@x.com' },
    })
    expect(res.created).toBe(0)
    expect(res.skipped).toBe(1)
    expect(createSD).not.toHaveBeenCalled()
  })
})
