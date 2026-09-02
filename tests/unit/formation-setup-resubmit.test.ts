/**
 * formation_setup handler — behaviour on a re-submitted formation (dev job ca788354).
 *
 * These tests run against the REAL handler and describe the behaviour Antonio
 * approved on 2026-08-10. They are expected to FAIL before the fix — each
 * failure is one of the production defects, reproduced:
 *
 *  1. A finished formation gets a SECOND Company Formation delivery minted
 *     beside it (Turcanu, 2026-07-27). Only ONE run is needed; the existing
 *     check matches `status='active'` only, and 178 of 195 formations in
 *     production are completed.
 *  2. The client is notified "Formation data received!" all over again for a
 *     company formed weeks earlier (Pasztor and Covelli each got three).
 *  3. The form record's reviewed status and completion timestamps are
 *     re-stamped with the re-run time — Pasztor's submission of 2026-06-25 now
 *     reads completed AND reviewed 2026-07-12, seventeen days adrift.
 *  4. A "WhatsApp follow-up" task is created. Retired by Antonio 2026-08-10;
 *     must never be created again, on any path.
 *  5. The delivery is created with no offer stamp at all, so it is untraceable
 *     AND the database's own uniqueness rule cannot apply. The stamp must be
 *     the resolved OFFER token — never the submission token the payload
 *     carries (that value would break the offer→account link entirely).
 *
 * What must KEEP working on a refusal: the client's correction still reaches
 * their contact record, and staff still get an email — so the overwrite gets
 * human review instead of vanishing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks: every dependency the handler reaches for ──
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn(), storage: { from: vi.fn() } } }))
vi.mock('@/lib/operations/service-delivery', () => ({
  createSD: vi.fn(),
  OPEN_TASK_STATUSES: ['To Do', 'In Progress', 'Waiting'],
}))
vi.mock('@/lib/service-delivery', () => ({ advanceServiceDelivery: vi.fn() }))
vi.mock('../queue', () => ({ updateJobProgress: vi.fn() }))
vi.mock('@/lib/jobs/queue', () => ({ updateJobProgress: vi.fn() }))
vi.mock('@/lib/jobs/validation', () => ({ validateFormationData: vi.fn(() => ({ valid: true, errors: [] })) }))
vi.mock('@/lib/drive-folder-utils', () => ({
  ensureContactFolder: vi.fn(async () => ({ folderId: 'FOLDER-1', created: false, subfolders: {} })),
}))
vi.mock('@/lib/gmail', () => ({ gmailPost: vi.fn(async () => ({ id: 'MSG-1' })) }))
vi.mock('@/lib/portal/notifications', () => ({ createPortalNotification: vi.fn(async () => undefined) }))
vi.mock('@/lib/portal/chat-events', () => ({
  emitFormationWizardSubmittedEvent: vi.fn(async () => ({ emitted: true, message_id: 'NOTE-1' })),
  retireFormationWizardSubmittedNote: vi.fn(async () => ({ retired: 1 })),
}))
vi.mock('@/lib/operations/itin-from-wizard', () => ({
  createItinDeliveriesFromWizard: vi.fn(async () => ({ created: 0, skipped: 0, people: [] })),
}))

import { handleFormationSetup, buildIdentityDetail } from '@/lib/jobs/handlers/formation-setup'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { createSD } from '@/lib/operations/service-delivery'
import { advanceServiceDelivery } from '@/lib/service-delivery'
import { createPortalNotification } from '@/lib/portal/notifications'
import { gmailPost } from '@/lib/gmail'
import { emitFormationWizardSubmittedEvent, retireFormationWizardSubmittedNote } from '@/lib/portal/chat-events'

/** The submission token the payload actually carries — NOT an offer token. */
const SUBMISSION_TOKEN = 'portal-dionisie-turcanu-2026-b3e39fbc'
/** The real offer token, the shape that lives on a correctly stamped delivery. */
const OFFER_TOKEN = 'dionisie-turcanu-2026'

const CONTACT_ID = 'b3e39fbc-aedb-4ec2-b7a9-180ff27fa250'
const LEAD_ID = 'bf947521-714a-4eb7-b614-ba5a38a236b2'
const SUBMISSION_ID = '37d7ae92-f012-44a2-b0a0-ab2727c7760d'

interface Recorded {
  contactUpdates: Array<Record<string, unknown>>
  submissionUpdates: Array<Record<string, unknown>>
  taskInserts: Array<Record<string, unknown>>
  sdSelectFilters: Array<[string, unknown]>
}

/**
 * Installs a per-table supabase mock.
 *
 * IMPORTANT — this mock is deliberately FILTER-AWARE for service_deliveries:
 * it applies the recorded `.eq()` filters to the fixture rows. A filter-blind
 * mock (the shape used in wizard-submit-nonblocking) makes these assertions
 * pass vacuously, because the lookup would "find" a formation no matter what
 * it asked for — which is precisely the bug under test.
 */
function install(cfg: {
  /** Every Company Formation delivery this contact has. */
  formations?: Array<Record<string, unknown>>
  /** The offer row reachable from the payload's lead. */
  offer?: Record<string, unknown> | null
  /** Whether a submitted formation wizard_progress exists (drives the advance). */
  submittedWizard?: boolean
  /** formation_submissions fallback row (dev job 9a9c5cf5), keyed by this job's own submission_id. */
  fallbackSubmission?: Record<string, unknown> | false
  /** formation_submissions.status BEFORE this pass's own write (round 5 notification gate). Defaults to 'completed' (first pass, never reviewed yet). Pass null for "row not found". */
  priorSubmissionStatus?: string | null
}): Recorded {
  const rec: Recorded = { contactUpdates: [], submissionUpdates: [], taskInserts: [], sdSelectFilters: [] }
  const formations = cfg.formations ?? []

  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    if (table === 'contacts') {
      const chain: Record<string, unknown> = {
        update: (row: Record<string, unknown>) => {
          rec.contactUpdates.push(row)
          return { eq: () => Promise.resolve({ error: null }) }
        },
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      }
      return chain
    }

    if (table === 'service_deliveries') {
      const filters: Array<[string, unknown]> = []

      /** Apply the filters the code actually asked for. */
      const matching = (): Array<Record<string, unknown>> =>
        formations.filter((row) =>
          filters.every(([col, val]) => {
            if (col === 'id' || col === 'contact_id' || col === 'service_type') return row[col] === val
            if (col === 'status' || col === 'source_offer_token') return row[col] === val
            return true
          }),
        )

      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters.push([col, val])
          rec.sdSelectFilters.push([col, val])
          return chain
        },
        order: () => chain,
        or: () => chain,
        is: (col: string, val: unknown) => { filters.push([col, val]); return chain },
        limit: () => Promise.resolve({ data: matching(), error: null }),
        // The refuse path re-reads the identified delivery by id. Without this
        // the chain throws, the handler swallows it, and the stage-advance
        // guard is never reached — a mutation of that guard would then leave
        // its test green. Mutation testing caught exactly that.
        maybeSingle: () => Promise.resolve({ data: matching()[0] ?? null, error: null }),
      }

      return chain
    }

    if (table === 'wizard_progress') {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: () =>
          Promise.resolve({ data: cfg.submittedWizard === false ? null : { id: 'WP-1' }, error: null }),
      }
      return chain
    }

    if (table === 'formation_submissions') {
      let lastSelect = ''
      // Mirrors the real TOCTOU guard (round 7): the form-reviewed UPDATE
      // chains .eq('id',...).eq('status','completed').select('id') — only
      // "applies" (affects a row) when the row's CURRENT status is still
      // 'completed', same rule cfg.priorSubmissionStatus already encodes
      // for the prior-status read above.
      const priorStatus = cfg.priorSubmissionStatus === undefined ? 'completed' : cfg.priorSubmissionStatus
      const chain: Record<string, unknown> = {
        update: (row: Record<string, unknown>) => {
          rec.submissionUpdates.push(row)
          const updateChain = {
            eq: () => updateChain,
            select: () =>
              Promise.resolve({
                data: priorStatus === 'completed' ? [{ id: SUBMISSION_ID }] : [],
                error: null,
              }),
          }
          return updateChain
        },
        select: (cols: string) => {
          lastSelect = cols
          return chain
        },
        eq: () => chain,
        in: () => chain,
        maybeSingle: () => {
          // .select('status') = the prior-status read before form_reviewed
          // (dev job 9a9c5cf5, round 5) — distinct from .select('id, status'),
          // the stage-advance fallback read (round 3). Same table, two
          // different callers; distinguish by the columns actually asked for.
          if (lastSelect === 'status') {
            return Promise.resolve({
              data: cfg.priorSubmissionStatus === undefined ? { status: 'completed' } : (cfg.priorSubmissionStatus === null ? null : { status: cfg.priorSubmissionStatus }),
              error: null,
            })
          }
          return Promise.resolve({
            data: cfg.fallbackSubmission === false ? null : (cfg.fallbackSubmission ?? null),
            error: null,
          })
        },
      }
      return chain
    }

    if (table === 'offers') {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: cfg.offer ?? null, error: null }),
      }
      return chain
    }

    if (table === 'tasks') {
      // The duplicate-check chain is .select().eq().eq().ilike().in().limit().
      // Every link must stay chainable: if `.in()` resolves early, `.limit()`
      // is called on a promise, the handler throws into its own catch, and the
      // insert never runs — so a "no WhatsApp task" assertion would pass while
      // the step it is guarding was never reached. That is a vacuous green.
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        ilike: () => chain,
        in: () => chain,
        limit: () => Promise.resolve({ data: [], error: null }),
        insert: (row: Record<string, unknown>) => {
          rec.taskInserts.push(row)
          return Promise.resolve({ error: null })
        },
      }
      return chain
    }

    if (table === 'documents') {
      return { insert: () => Promise.resolve({ error: null }) }
    }

    const fallback: Record<string, unknown> = {
      select: () => fallback,
      eq: () => fallback,
      limit: () => Promise.resolve({ data: [], error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      insert: () => Promise.resolve({ error: null }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }
    return fallback
  }) as unknown as typeof supabaseAdmin.from)

  return rec
}

const job = () =>
  ({
    id: 'JOB-1',
    payload: {
      token: SUBMISSION_TOKEN,
      submission_id: SUBMISSION_ID,
      contact_id: CONTACT_ID,
      lead_id: LEAD_ID,
      source: 'portal_wizard',
      submitted_data: {
        owner_first_name: 'Dionisie',
        owner_last_name: 'Turcanu',
        owner_email: 'client@example.com',
        llc_name_1: 'Automatiko LLC',
      },
    },
  }) as never

/** Turcanu's real shape: finished AND materialized into a real company. */
const FINISHED_FORMATION = {
  id: '01e770b8-c233-4a13-b5ee-a463750c7dc9',
  contact_id: CONTACT_ID,
  account_id: 'ACCOUNT-AUTOMATIKO',
  service_type: 'Company Formation',
  stage: 'EIN Received',
  status: 'completed',
  source_offer_token: OFFER_TOKEN,
}

/**
 * Decode what actually reached support@. The payload is base64url of the whole
 * MIME message; the subject is an RFC 2047 base64 word and the body is base64
 * again, so a single decode reads as gibberish and would let any assertion
 * about the wording pass or fail for the wrong reason.
 */
function readStaffEmail(): string {
  const arg = vi.mocked(gmailPost).mock.calls[0]?.[1] as { raw?: string } | undefined
  if (!arg?.raw) return ''
  const mime = Buffer.from(arg.raw, 'base64url').toString('utf8')
  const subject = (mime.match(/=\?utf-8\?B\?(.+?)\?=/i)?.[1] ?? '')
  const body = mime.split('\r\n\r\n').slice(1).join('\r\n\r\n')
  return [
    Buffer.from(subject, 'base64').toString('utf8'),
    Buffer.from(body, 'base64').toString('utf8'),
  ].join('\n')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(createSD).mockResolvedValue({ id: 'SD-NEW' } as never)
  vi.mocked(advanceServiceDelivery).mockResolvedValue({ success: true } as never)
})

describe('re-submit against a FINISHED formation (the Turcanu shape)', () => {
  it('creates NO second Company Formation delivery', async () => {
    install({ formations: [FINISHED_FORMATION], offer: { token: OFFER_TOKEN } })
    await handleFormationSetup(job())
    expect(createSD).not.toHaveBeenCalled()
  })

  it('advances NO stage', async () => {
    install({ formations: [FINISHED_FORMATION], offer: { token: OFFER_TOKEN } })
    await handleFormationSetup(job())
    expect(advanceServiceDelivery).not.toHaveBeenCalled()
  })

  it('advances NO stage even when the finished formation still sits at Payment Confirmed', async () => {
    // Without this shape the stage guard is untestable: the Turcanu fixture is
    // at "EIN Received", so the pre-existing stage precondition blocks the
    // advance on its own and removing the gate changes nothing. A formation
    // that materialized into a real company while its delivery was never
    // advanced is the case where the gate alone does the work.
    install({
      formations: [{ ...FINISHED_FORMATION, stage: 'Payment Confirmed', status: 'active' }],
      offer: { token: OFFER_TOKEN },
    })
    await handleFormationSetup(job())
    expect(advanceServiceDelivery).not.toHaveBeenCalled()
  })

  it('sends the client NO "Formation data received!" notification', async () => {
    install({ formations: [FINISHED_FORMATION], offer: { token: OFFER_TOKEN } })
    await handleFormationSetup(job())
    expect(createPortalNotification).not.toHaveBeenCalled()
  })

  it('does NOT reset the form status or re-stamp its completion timestamps', async () => {
    // Pasztor: submitted 2026-06-25, record now reads 2026-07-12. 17 days.
    const rec = install({ formations: [FINISHED_FORMATION], offer: { token: OFFER_TOKEN } })
    await handleFormationSetup(job())
    const touched = rec.submissionUpdates.filter(
      (u) => 'status' in u || 'completed_at' in u || 'reviewed_at' in u,
    )
    expect(touched).toEqual([])
  })

  it('STILL writes the client correction to the contact', async () => {
    const rec = install({ formations: [FINISHED_FORMATION], offer: { token: OFFER_TOKEN } })
    await handleFormationSetup(job())
    expect(rec.contactUpdates.length).toBeGreaterThan(0)
  })

  it('STILL emails staff so the overwrite gets human review', async () => {
    install({ formations: [FINISHED_FORMATION], offer: { token: OFFER_TOKEN } })
    await handleFormationSetup(job())
    expect(gmailPost).toHaveBeenCalled()
  })

  it('the staff email says a FINISHED formation was re-submitted', async () => {
    install({ formations: [FINISHED_FORMATION], offer: { token: OFFER_TOKEN } })
    await handleFormationSetup(job())
    expect(readStaffEmail().toLowerCase()).toContain('re-submit')
  })

  it('the staff email shows WHAT the re-submit changed on the contact', async () => {
    // Antonio: the overwrite must get human review, not just an announcement.
    install({ formations: [FINISHED_FORMATION], offer: { token: OFFER_TOKEN } })
    await handleFormationSetup(job())
    expect(readStaffEmail().toLowerCase()).toContain('what changed on the contact')
  })

  it('the staff email says the client was NOT notified', async () => {
    install({ formations: [FINISHED_FORMATION], offer: { token: OFFER_TOKEN } })
    await handleFormationSetup(job())
    expect(readStaffEmail().toLowerCase()).toContain('not notified')
  })

  it('reports the refusal on the job rather than a silent success', async () => {
    install({ formations: [FINISHED_FORMATION], offer: { token: OFFER_TOKEN } })
    const result = await handleFormationSetup(job())
    const names = result.steps.map((s) => s.name)
    expect(names).toContain('formation_resubmit_refused')
  })
})

/** Francesco Lussignoli's shape: active, unfinished, still at Payment Confirmed. */
const UNFINISHED_FORMATION = {
  id: 'SD-UNFINISHED',
  contact_id: CONTACT_ID,
  account_id: null,
  service_type: 'Company Formation',
  stage: 'Payment Confirmed',
  status: 'active',
  source_offer_token: OFFER_TOKEN,
}

describe('stage-advance fallback when wizard_progress silently failed to write (dev job 9a9c5cf5)', () => {
  it('still advances the stage when wizard_progress is missing but this job\'s own submission is completed/reviewed', async () => {
    install({
      formations: [UNFINISHED_FORMATION],
      offer: { token: OFFER_TOKEN },
      submittedWizard: false,
      fallbackSubmission: { id: SUBMISSION_ID, status: 'reviewed' },
    })
    await handleFormationSetup(job())
    expect(advanceServiceDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ delivery_id: 'SD-UNFINISHED', target_stage: 'Wizard Submitted' }),
    )
  })

  it('does NOT advance when wizard_progress is missing and there is no fallback submission either', async () => {
    install({
      formations: [UNFINISHED_FORMATION],
      offer: { token: OFFER_TOKEN },
      submittedWizard: false,
      fallbackSubmission: false,
    })
    await handleFormationSetup(job())
    expect(advanceServiceDelivery).not.toHaveBeenCalled()
  })

  it('prefers the real wizard_progress row when it exists, without needing the fallback', async () => {
    install({
      formations: [UNFINISHED_FORMATION],
      offer: { token: OFFER_TOKEN },
      submittedWizard: true,
      fallbackSubmission: false,
    })
    await handleFormationSetup(job())
    expect(advanceServiceDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ delivery_id: 'SD-UNFINISHED', target_stage: 'Wizard Submitted' }),
    )
  })
})

describe('staff What\'s New alert on wizard submission (dev job 9a9c5cf5, round 5)', () => {
  it('fires the alert on a genuine first submission', async () => {
    install({
      formations: [UNFINISHED_FORMATION],
      offer: { token: OFFER_TOKEN },
      priorSubmissionStatus: 'completed', // never reviewed before this pass
    })
    await handleFormationSetup(job())
    expect(emitFormationWizardSubmittedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ formation_submission_id: SUBMISSION_ID, is_resubmission: false }),
    )
    expect(retireFormationWizardSubmittedNote).not.toHaveBeenCalled()
  })

  it('marks it a resubmission in the wording when the row was already reviewed, WITHOUT retiring the existing note (bug-hunter finding, round 6)', async () => {
    // The old behavior (retire-then-refire keyed on the row's own status)
    // let a mid-job crash-and-retry — this job's own PRIOR successful
    // attempt already flipped status to "reviewed" — misread itself as a
    // genuine client resubmission and DELETE the correct, already-emitted
    // note. Retiring must never happen automatically from this signal
    // alone; emitClientChatEvent's own marker dedup is what protects a
    // retry from creating a duplicate/false note.
    install({
      formations: [UNFINISHED_FORMATION],
      offer: { token: OFFER_TOKEN },
      priorSubmissionStatus: 'reviewed',
    })
    await handleFormationSetup(job())
    expect(retireFormationWizardSubmittedNote).not.toHaveBeenCalled()
    expect(emitFormationWizardSubmittedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ is_resubmission: true }),
    )
  })

  it('does NOT fire for a refused re-submit against a FINISHED formation (deliberately silent, dev job ca788354)', async () => {
    install({ formations: [FINISHED_FORMATION], offer: { token: OFFER_TOKEN } })
    await handleFormationSetup(job())
    expect(emitFormationWizardSubmittedEvent).not.toHaveBeenCalled()
    expect(retireFormationWizardSubmittedNote).not.toHaveBeenCalled()
  })
})

describe('form-reviewed timestamps never get re-stamped on a repeat pass (dev job 9a9c5cf5, round 7)', () => {
  it('stamps reviewed_at/completed_at on a genuine first pass (row still "completed")', async () => {
    const rec = install({
      formations: [UNFINISHED_FORMATION],
      offer: { token: OFFER_TOKEN },
      priorSubmissionStatus: 'completed',
    })
    const result = await handleFormationSetup(job())
    const reviewedStep = result.steps.find((s) => s.name === 'form_reviewed')
    expect(reviewedStep?.status).toBe('ok')
    expect(rec.submissionUpdates.some((u) => u.status === 'reviewed')).toBe(true)
  })

  it('does NOT re-stamp reviewed_at/completed_at when the row is already reviewed — a job retry of its own prior success must be a safe no-op', async () => {
    // This is the exact bug-hunter repro: the row's status is already
    // "reviewed" (either from this same job's own earlier, since-retried
    // attempt, OR a genuine resubmit the route already preserved as
    // "reviewed" per preserveReviewedStatus/ca788354) — the write must be
    // a provable no-op, never re-stamp to "now" again.
    install({
      formations: [UNFINISHED_FORMATION],
      offer: { token: OFFER_TOKEN },
      priorSubmissionStatus: 'reviewed',
    })
    const result = await handleFormationSetup(job())
    const reviewedStep = result.steps.find((s) => s.name === 'form_reviewed')
    expect(reviewedStep?.status).toBe('skipped')
  })

  it('still fires the staff alert even when the timestamp re-stamp is skipped (dedup, not the write, gates the notification)', async () => {
    install({
      formations: [UNFINISHED_FORMATION],
      offer: { token: OFFER_TOKEN },
      priorSubmissionStatus: 'reviewed',
    })
    await handleFormationSetup(job())
    expect(emitFormationWizardSubmittedEvent).toHaveBeenCalled()
  })
})

describe('the WhatsApp follow-up task is retired everywhere', () => {
  it('creates no WhatsApp task on a first run', async () => {
    const rec = install({ formations: [], offer: { token: OFFER_TOKEN } })
    await handleFormationSetup(job())
    const whatsapp = rec.taskInserts.filter((t) => String(t.task_title ?? '').includes('WhatsApp'))
    expect(whatsapp).toEqual([])
  })

  it('creates no WhatsApp task on a re-submit either', async () => {
    const rec = install({ formations: [FINISHED_FORMATION], offer: { token: OFFER_TOKEN } })
    await handleFormationSetup(job())
    const whatsapp = rec.taskInserts.filter((t) => String(t.task_title ?? '').includes('WhatsApp'))
    expect(whatsapp).toEqual([])
  })
})

describe('source stamping — the OFFER token, never the submission token', () => {
  it('stamps the delivery with the resolved offer token', async () => {
    install({ formations: [], offer: { token: OFFER_TOKEN } })
    await handleFormationSetup(job())
    expect(createSD).toHaveBeenCalledWith(
      expect.objectContaining({ source_offer_token: OFFER_TOKEN }),
    )
  })

  it('NEVER writes the submission token into the offer field', async () => {
    // Writing `portal-…` there breaks the offer→account link at
    // materialization (the client's portal keeps saying "Set up your new
    // company" forever) AND leaves activation's dedup unable to match.
    install({ formations: [], offer: { token: OFFER_TOKEN } })
    await handleFormationSetup(job())
    const arg = vi.mocked(createSD).mock.calls[0]?.[0] as unknown as Record<string, unknown> | undefined
    expect(arg?.source_offer_token).not.toBe(SUBMISSION_TOKEN)
    expect(String(arg?.source_offer_token ?? '')).not.toMatch(/^portal-/)
  })

  it('writes NOTHING rather than a fake when the offer cannot be resolved', async () => {
    // Explicitly null, not merely absent — an absent field would let this pass
    // today (nothing is stamped at all) and the assertion would prove nothing.
    install({ formations: [], offer: null })
    await handleFormationSetup(job())
    const arg = vi.mocked(createSD).mock.calls[0]?.[0] as unknown as Record<string, unknown> | undefined
    expect(arg).toBeDefined()
    expect(arg).toHaveProperty('source_offer_token')
    expect(arg?.source_offer_token).toBeNull()
  })

  it('records the originating job and submission on the delivery', async () => {
    install({ formations: [], offer: { token: OFFER_TOKEN } })
    await handleFormationSetup(job())
    const arg = vi.mocked(createSD).mock.calls[0]?.[0] as unknown as Record<string, unknown> | undefined
    expect(String(arg?.notes ?? '')).toContain(SUBMISSION_ID)
  })
})

describe('the lookup must not be keyed on the contact alone', () => {
  it('asks about THIS offer, not merely "any active formation for this person"', async () => {
    // Mutation guard: if the fix reverts to contact+status keying, no
    // source_offer_token filter is ever issued and this fails.
    const rec = install({ formations: [FINISHED_FORMATION], offer: { token: OFFER_TOKEN } })
    await handleFormationSetup(job())
    const askedAboutOffer = rec.sdSelectFilters.some(([col]) => col === 'source_offer_token')
    const askedActiveOnly = rec.sdSelectFilters.some(
      ([col, val]) => col === 'status' && val === 'active',
    )
    expect(askedAboutOffer || !askedActiveOnly).toBe(true)
  })

  it('a second company for the same person is still created', async () => {
    // The first company is finished and stamped with a DIFFERENT offer.
    install({ formations: [FINISHED_FORMATION], offer: { token: 'a-different-offer-2026' } })
    await handleFormationSetup(job())
    expect(createSD).toHaveBeenCalled()
  })
})

describe('build identity — the job states which code produced its result', () => {
  // The 2026-08-10 stale-build incident: the sandbox served new pages and an
  // OLD compiled handler, so a deleted step still ran and every job-level QA
  // result that evening was meaningless while looking green. "Which handler
  // ran" must be a fact in the log, never an inference.

  it('is the FIRST step of every run, before anything can fail', async () => {
    install({ formations: [], offer: { token: OFFER_TOKEN } })
    const result = await handleFormationSetup(job())
    expect(result.steps[0]?.name).toBe('build_identity')
  })

  it('is emitted even when validation rejects the submission', async () => {
    const { validateFormationData } = await import('@/lib/jobs/validation')
    vi.mocked(validateFormationData).mockReturnValueOnce({
      valid: false,
      errors: [{ field: 'owner_email', message: 'required' }],
    } as never)
    install({ formations: [], offer: { token: OFFER_TOKEN } })
    const result = await handleFormationSetup(job())
    expect(result.steps[0]?.name).toBe('build_identity')
  })

  it('names the handler revision, the deployment and the commit', () => {
    const detail = buildIdentityDetail({ deploymentId: 'dpl_abc123', commitSha: '0123456789abcdef' })
    expect(detail).toContain('handler=')
    expect(detail).toContain('deployment=dpl_abc123')
    expect(detail).toContain('commit=0123456')
  })

  it('says so plainly when it is not running on a deployment', () => {
    const detail = buildIdentityDetail({})
    expect(detail).toContain('deployment=local')
    expect(detail).toContain('commit=n/a')
  })

  it('carries a revision string that changes when this handler changes', () => {
    // A constant that a stale bundle cannot fake: if the deployed job reports
    // an older revision than the source, the deployment is stale.
    expect(buildIdentityDetail({})).toMatch(/handler=ca788354-resubmit-gate-v\d+/)
  })
})
