import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──
vi.mock('@/lib/services', () => ({ getStartAtWizardServiceTypes: vi.fn() }))
vi.mock('@/lib/operations/service-delivery', () => ({ createSD: vi.fn() }))
vi.mock('@/lib/operations/find-contact-by-email', () => ({ findContactIdByEmail: vi.fn() }))
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))

import { createItinDeliveriesFromWizard } from '@/lib/operations/itin-from-wizard'
import { getStartAtWizardServiceTypes } from '@/lib/services'
import { createSD } from '@/lib/operations/service-delivery'
import { findContactIdByEmail } from '@/lib/operations/find-contact-by-email'
import { supabaseAdmin } from '@/lib/supabase-admin'

// Per-table chainable mock. Terminal reads resolve to configured values.
// cfg: { pipelineStages, contactInsertId, sdDup, sdDupError }
function installFrom(cfg: {
  pipelineStages?: unknown[]
  contactInsertId?: string
  /** Rows the per-person ITIN dedup SELECT returns. */
  sdDup?: unknown[]
  /** Force the dedup SELECT to fail (must fail CLOSED, never create). */
  sdDupError?: { message: string }
}) {
  const contactInserts: Array<Record<string, unknown>> = []
  const taskInserts: Array<Record<string, unknown>> = []
  const sdUpdates: Array<Record<string, unknown>> = []

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
      // Dedup SELECT terminates on .limit(); noteSkippedOffer's read terminates
      // on .maybeSingle() and then issues an .update().eq().
      const p = Promise.resolve({
        data: cfg.sdDupError ? null : (cfg.sdDup ?? []),
        error: cfg.sdDupError ?? null,
      })
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        or: () => chain,
        ilike: () => chain,
        limit: () => p,
        maybeSingle: () => Promise.resolve({ data: { notes: 'existing notes' }, error: null }),
        update: (row: Record<string, unknown>) => {
          sdUpdates.push(row)
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
      return chain
    }
    if (table === 'tasks') {
      return { insert: (row: Record<string, unknown>) => { taskInserts.push(row); return Promise.resolve({ error: null }) } }
    }
    return { select: () => ({}) }
  }) as never)

  return { contactInserts, taskInserts, sdUpdates }
}

const OWNER = 'owner-contact-1'
const LEAD = 'lead-1'

describe('createItinDeliveriesFromWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getStartAtWizardServiceTypes).mockResolvedValue(['ITIN'])
    vi.mocked(findContactIdByEmail).mockResolvedValue(null) // default: not found
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
      contactInsertId: 'peter-contact',
    })
    vi.mocked(findContactIdByEmail).mockResolvedValue(null) // not found → insert
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
    })
    vi.mocked(findContactIdByEmail).mockResolvedValue('hamza-existing') // found → reuse
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

  it('idempotent — skips a person who already has a live ITIN SD', async () => {
    installFrom({ pipelineStages: [{ stage_order: 0, auto_tasks: [] }], sdDup: [{ id: 'existing-sd' }] })
    const res = await createItinDeliveriesFromWizard({
      contactId: OWNER, leadId: LEAD, offerToken: 'tok',
      submitted: { owner_needs_itin: true, owner_first_name: 'Adam', owner_email: 'a@x.com' },
    })
    expect(res.created).toBe(0)
    expect(res.skipped).toBe(1)
    expect(createSD).not.toHaveBeenCalled()
  })

  // ── Regression: Marcell Bogyora, 2026-07-20 ──
  // The guard used to match `notes ILIKE '%<offerToken>%'`. When the submission
  // token gained a per-subject suffix, a re-submitted wizard minted a token that
  // no longer matched the existing SD's notes → duplicate ITIN in the client's
  // portal. The guard must now ignore the token entirely.
  it('skips an existing ITIN even when the offer token has changed shape', async () => {
    installFrom({
      pipelineStages: [{ stage_order: 0, auto_tasks: [] }],
      sdDup: [{ id: 'existing-sd' }], // exists, but under the OLD token
    })
    const res = await createItinDeliveriesFromWizard({
      contactId: OWNER, leadId: LEAD,
      offerToken: 'portal-marcell-bogyora-2026-f53451cf', // NEW shape
      submitted: { owner_needs_itin: true, owner_first_name: 'Marcell', owner_email: 'm@x.com' },
    })
    expect(res.created).toBe(0)
    expect(res.skipped).toBe(1)
    expect(createSD).not.toHaveBeenCalled()
    // Reported to the caller — and deliberately NOT written into the SD's
    // freetext notes, which is the pattern that caused this bug.
    expect(res.people[0]?.detail).toContain('already has a live ITIN')
  })

  it('fails CLOSED — a dedup-check error skips the person instead of creating', async () => {
    installFrom({
      pipelineStages: [{ stage_order: 0, auto_tasks: [] }],
      sdDupError: { message: 'statement timeout' },
    })
    const res = await createItinDeliveriesFromWizard({
      contactId: OWNER, leadId: LEAD, offerToken: 'tok',
      submitted: { owner_needs_itin: true, owner_first_name: 'Adam', owner_email: 'a@x.com' },
    })
    expect(res.created).toBe(0)
    expect(createSD).not.toHaveBeenCalled()
    expect(res.people[0].status).toBe('error')
    expect(res.people[0].detail).toContain('statement timeout')
  })

  it('treats a unique-violation from the DB backstop as "already exists"', async () => {
    installFrom({ pipelineStages: [{ stage_order: 0, auto_tasks: [] }] })
    vi.mocked(createSD).mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "uq_itin_sd_active_per_contact" (23505)'),
    )
    const res = await createItinDeliveriesFromWizard({
      contactId: OWNER, leadId: LEAD, offerToken: 'tok',
      submitted: { owner_needs_itin: true, owner_first_name: 'Adam', owner_email: 'a@x.com' },
    })
    expect(res.created).toBe(0)
    expect(res.skipped).toBe(1)
    expect(res.people[0].status).toBe('existing')
  })

  it('re-throws a non-unique createSD failure (never silently swallowed)', async () => {
    installFrom({ pipelineStages: [{ stage_order: 0, auto_tasks: [] }] })
    vi.mocked(createSD).mockRejectedValueOnce(new Error('some other DB failure'))
    const res = await createItinDeliveriesFromWizard({
      contactId: OWNER, leadId: LEAD, offerToken: 'tok',
      submitted: { owner_needs_itin: true, owner_first_name: 'Adam', owner_email: 'a@x.com' },
    })
    // caught by the per-applicant try/catch and reported, not created
    expect(res.created).toBe(0)
    expect(res.people[0].status).toBe('error')
    expect(res.people[0].detail).toContain('some other DB failure')
  })
})
