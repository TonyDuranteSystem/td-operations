import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'

// ── database + release mock (for approveTaxSubmission) ─────────────────────────────────────────────────────
type Scenario = {
  sub: Record<string, unknown> | null // the row the submission lookup returns
  subs: Array<Record<string, unknown>> // the account's submissions (service-delivery door)
  sd: Record<string, unknown> | null
  openYears: number[]
  updated: Array<{ id: string }> // rows the guarded UPDATE touched
}
let scenario: Scenario
const writes: Array<{ table: string; payload: Record<string, unknown>; guards: Array<[string, unknown]> }> = []

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      let mode: 'select' | 'update' = 'select'
      let single = false
      let write: { table: string; payload: Record<string, unknown>; guards: Array<[string, unknown]> } | null = null
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.update = (payload: Record<string, unknown>) => {
        mode = 'update'
        write = { table, payload, guards: [] }
        writes.push(write)
        return chain
      }
      chain.eq = (col: string, val: unknown) => {
        write?.guards.push([col, val])
        return chain
      }
      chain.is = () => chain
      chain.maybeSingle = () => {
        single = true
        return chain
      }
      chain.then = (resolve: (v: unknown) => unknown) => {
        let data: unknown = null
        if (table === 'tax_return_submissions') data = mode === 'update' ? scenario.updated : single ? scenario.sub : scenario.subs
        else if (table === 'service_deliveries') data = scenario.sd
        else if (table === 'tax_returns') data = scenario.openYears.map((tax_year) => ({ tax_year }))
        return Promise.resolve({ data, error: null }).then(resolve)
      }
      return chain
    },
  },
}))

const applyMock = vi.fn(async (p: unknown) => {
  void p
  return [{ step: 'tax_return', status: 'ok' as const }]
})
vi.mock('@/lib/tax/apply-confirmed-submission', () => ({ applyConfirmedTaxSubmission: (p: unknown) => applyMock(p) }))

import { approveTaxSubmission, approvalNeedsWarning } from '@/lib/tax/approve-submission'
import { canStaffApprove, buildReviewHistoryEntry } from '@/lib/tax/review-status'
import { pickTargetSubmission } from '@/lib/tax/pick-target-submission'
import { actionTargetStage, DEFAULT_ACTION_TARGET } from '@/lib/flows/action-target'
import { flowStageBannerState, taxBannerFlowState, stageOwnsBanner, isPostReviewBannerState, hasTaxReturnToSign } from '@/lib/tax/flow-banner'

const read = (p: string) => readFileSync(p, 'utf8')
const SUB = { id: 'sub-1', account_id: 'acc-1', tax_year: 2025, review_status: 'under_review', review_history: [], created_at: '2026-10-01T00:00:00Z' }

beforeEach(() => {
  writes.length = 0
  applyMock.mockClear()
  scenario = { sub: { ...SUB }, subs: [{ ...SUB }], sd: { service_type: 'Tax Return', account_id: 'acc-1' }, openYears: [2025], updated: [{ id: 'sub-1' }] }
})

describe('approveTaxSubmission — approval releases the submission (client Confirm step removed)', () => {
  it('under_review → confirmed in ONE write with a staff history round, then releases the tax record and job', async () => {
    const r = await approveTaxSubmission({ submissionId: 'sub-1', by: 'Luca' })
    expect(r.status).toBe('approved')
    const upd = writes.find((w) => w.table === 'tax_return_submissions')!
    expect(upd.payload.review_status).toBe('confirmed')
    const hist = upd.payload.review_history as Array<Record<string, unknown>>
    expect(hist).toHaveLength(1)
    expect(hist[0]).toMatchObject({ from: 'under_review', to: 'confirmed', actor: 'staff', by: 'Luca' })
    // pinned to the prior value, so a concurrent writer is never clobbered
    expect(upd.guards).toContainEqual(['review_status', 'under_review'])
    expect(applyMock).toHaveBeenCalledWith({ account_id: 'acc-1', tax_year: 2025, actor: 'staff:Luca' })
  })

  it('resolves the open What\'s New card for that submission', async () => {
    await approveTaxSubmission({ submissionId: 'sub-1', by: 'Luca' })
    const card = writes.find((w) => w.table === 'message_actions')!
    expect(card.guards).toContainEqual(['source_ref', 'tax_submission:sub-1'])
    expect(card.payload.resolved_at).toBeTruthy()
  })

  it('works from submitted, resubmitted and a submission left at approved by the old two-step flow', async () => {
    for (const from of ['submitted', 'resubmitted', 'approved']) {
      scenario.sub = { ...SUB, review_status: from }
      expect((await approveTaxSubmission({ submissionId: 'sub-1', by: 'L' })).status).toBe('approved')
    }
  })

  it('is idempotent: a second press on a released submission changes nothing', async () => {
    scenario.sub = { ...SUB, review_status: 'confirmed' }
    const r = await approveTaxSubmission({ submissionId: 'sub-1', by: 'L' })
    expect(r.status).toBe('already_released')
    expect(writes).toHaveLength(0)
    expect(applyMock).not.toHaveBeenCalled()
  })

  it('refuses while the client is still editing (changes requested / reopened) and writes nothing', async () => {
    for (const from of ['revision_requested', 'reopened']) {
      scenario.sub = { ...SUB, review_status: from }
      const r = await approveTaxSubmission({ submissionId: 'sub-1', by: 'L' })
      expect(r.status).toBe('not_approvable')
    }
    expect(writes).toHaveLength(0)
  })

  it('a submission that never entered the review (review_status null) has nothing to release', async () => {
    scenario.sub = { ...SUB, review_status: null }
    const r = await approveTaxSubmission({ submissionId: 'sub-1', by: 'L' })
    expect(r.status).toBe('not_in_review')
    expect(writes).toHaveLength(0)
  })

  it('reports a conflict (and does not release) when a concurrent writer moved the row first', async () => {
    scenario.updated = []
    const r = await approveTaxSubmission({ submissionId: 'sub-1', by: 'L' })
    expect(r.status).toBe('conflict')
    expect(applyMock).not.toHaveBeenCalled()
  })

  it('workspace door: finds the account\'s oldest-open-year submission from the service delivery', async () => {
    scenario.subs = [
      { ...SUB, id: 'old', tax_year: 2024, created_at: '2025-05-01T00:00:00Z' },
      { ...SUB, id: 'sub-1', tax_year: 2025 },
    ]
    scenario.openYears = [2025]
    const r = await approveTaxSubmission({ serviceDeliveryId: 'sd-1', by: 'flow-action' })
    expect(r.status).toBe('approved')
    expect(r.submissionId).toBe('sub-1')
  })

  it('workspace door: a job with no submission (data uploaded by staff) is "no_submission", not an error', async () => {
    scenario.subs = []
    expect((await approveTaxSubmission({ serviceDeliveryId: 'sd-1', by: 'x' })).status).toBe('no_submission')
  })

  it('workspace door: a job that is not a tax flow is left alone', async () => {
    scenario.sd = { service_type: 'State Annual Report', account_id: 'acc-1' }
    expect((await approveTaxSubmission({ serviceDeliveryId: 'sd-1', by: 'x' })).status).toBe('not_tax_flow')
  })

  it('only the outcomes that need staff attention raise a warning', () => {
    for (const ok of ['approved', 'already_released', 'no_submission', 'not_in_review', 'not_tax_flow'] as const) expect(approvalNeedsWarning(ok)).toBe(false)
    for (const bad of ['not_approvable', 'conflict', 'error', 'no_account'] as const) expect(approvalNeedsWarning(bad)).toBe(true)
  })
})

describe('review-status: staff approval rule', () => {
  it('may approve while staff are reviewing or the client waits on us; never while the client edits or once released', () => {
    for (const s of ['submitted', 'resubmitted', 'under_review', 'approved'] as const) expect(canStaffApprove(s)).toBe(true)
    for (const s of ['revision_requested', 'reopened', 'confirmed'] as const) expect(canStaffApprove(s)).toBe(false)
    expect(canStaffApprove(null)).toBe(false)
  })
  it('a history round can name staff as the actor of a `confirmed` write, and still defaults to the usual actor', () => {
    const base = { from: 'under_review' as const, to: 'confirmed' as const, at: 't', by: 'Luca' }
    expect(buildReviewHistoryEntry({ ...base, actor: 'staff' }).actor).toBe('staff')
    expect(buildReviewHistoryEntry(base).actor).toBe('client')
  })
})

describe('pickTargetSubmission — one rule for Request Changes and Approve', () => {
  const s = (id: string, tax_year: number, created_at: string) => ({ id, tax_year, created_at })
  it('open record → the OLDEST open year\'s latest submission', () => {
    const subs = [s('a', 2024, '2025-04-01'), s('b', 2025, '2026-04-01'), s('c', 2025, '2026-05-01')]
    expect(pickTargetSubmission(subs, [2024, 2025])?.id).toBe('a')
    expect(pickTargetSubmission(subs, [2025])?.id).toBe('c')
  })
  it('no open record → the latest submission overall', () => {
    expect(pickTargetSubmission([s('a', 2024, '2025-04-01'), s('b', 2025, '2026-04-01')], [])?.id).toBe('b')
  })
  it('an open year with no submission of that year is "none" (never a different year)', () => {
    expect(pickTargetSubmission([s('a', 2024, '2025-04-01')], [2025])).toBeNull()
    expect(pickTargetSubmission([], [])).toBeNull()
  })
})

describe('workspace buttons go to stages the Tax Return pipeline really has', () => {
  const REAL = ['Company Data Pending', 'Paid - Awaiting Data', '1st Installment Paid', 'Extension Filed', 'Awaiting 2nd Payment', '2nd Installment Paid', 'Wizard Available', 'Data Submitted', 'Under Review', 'Revision Requested', 'Approved', 'Confirmed', 'Data Received', 'Preparation', 'TR Completed', 'TR Filed', 'Terminated - Non Payment']
  it('the stage layout\'s own target wins; the fallback is a real stage', () => {
    expect(actionTargetStage('approve', 'Data Received')).toBe('Data Received')
    expect(actionTargetStage('approve', '  ')).toBe('Data Received')
    expect(actionTargetStage('file_with_irs', 'TR Filed')).toBe('TR Filed')
    for (const k of ['start_review', 'approve', 'request_changes', 'file_with_irs']) expect(REAL).toContain(DEFAULT_ACTION_TARGET[k])
  })
  it('an unknown key with no target has no button', () => {
    expect(actionTargetStage('nope')).toBeNull()
  })
  it('the component no longer hard-codes the two stage names the pipeline does not have', () => {
    const src = read('components/flows/action-buttons.tsx')
    expect(src).toContain('actionTargetStage(')
    expect(src).not.toContain("'Review Completed'")
    expect(src).not.toContain("'Filed with IRS'")
  })
})

describe('client banner reads the real workspace steps', () => {
  it('Data Received / Preparation / Approved / Confirmed → being prepared', () => {
    for (const s of ['Data Received', 'Preparation', 'Approved', 'Confirmed']) expect(flowStageBannerState(s)).toBe('preparing')
  })
  it('Sent for Signature → sign; the older TR Completed → being prepared (nothing is out for signature yet); TR Filed → filed', () => {
    expect(flowStageBannerState('Sent for Signature')).toBe('sign')
    expect(flowStageBannerState('TR Completed')).toBe('preparing')
    expect(flowStageBannerState('TR Filed')).toBe('filed')
  })
  it('every real stage after the review maps; billing stages still fall through', () => {
    expect(flowStageBannerState('Awaiting 2nd Payment')).toBeNull()
    expect(flowStageBannerState('Extension Filed')).toBeNull()
    expect(flowStageBannerState('Terminated - Non Payment')).toBeNull()
  })
  it('"Sign your tax return" only when a document is really waiting; otherwise "being prepared"', () => {
    expect(taxBannerFlowState('Sent for Signature', true)).toBe('sign')
    expect(taxBannerFlowState('Sent for Signature', false)).toBe('preparing') // e.g. the document was cancelled or expired
    expect(taxBannerFlowState('TR Completed', true)).toBe('preparing')
    expect(taxBannerFlowState('Preparation', false)).toBe('preparing')
    expect(taxBannerFlowState('Wizard Available', false)).toBe('complete_form')
  })
  it('past the review the STEP decides — unless the client is still being asked to edit', () => {
    const prep = taxBannerFlowState('Data Received', false)
    expect(isPostReviewBannerState(prep)).toBe(true)
    for (const rs of [null, undefined, 'approved', 'confirmed']) expect(stageOwnsBanner(prep, rs)).toBe(true)
    for (const rs of ['revision_requested', 'reopened', 'submitted', 'resubmitted', 'under_review']) expect(stageOwnsBanner(prep, rs)).toBe(false)
  })
  it('before the review is finished the review message still decides', () => {
    for (const st of ['Wizard Available', 'Data Submitted', 'Under Review', 'Revision Requested']) {
      expect(stageOwnsBanner(taxBannerFlowState(st, false), 'confirmed')).toBe(false)
    }
    expect(stageOwnsBanner(null, 'confirmed')).toBe(false)
  })
  it('hasTaxReturnToSign: a tax-return document counts; a lease or operating agreement does not', () => {
    const doc = (documentName: string, status = 'awaiting', type = 'document') => ({ type, status, documentName })
    expect(hasTaxReturnToSign([doc('Tax Return 2025 - Acme LLC')])).toBe(true)
    expect(hasTaxReturnToSign([doc('Form 1120 2025 - Acme LLC - To Sign')])).toBe(true)
    expect(hasTaxReturnToSign([doc('Form 8879-PE')])).toBe(true)
    expect(hasTaxReturnToSign([doc('Tax Return 2025 - Acme LLC', 'signed')])).toBe(false)
    expect(hasTaxReturnToSign([{ type: 'lease', status: 'awaiting' }, doc('Operating Agreement')])).toBe(false)
    expect(hasTaxReturnToSign([{ type: 'oa', status: 'awaiting', documentName: 'Tax Return' }])).toBe(false)
    expect(hasTaxReturnToSign([])).toBe(false)
  })
})

describe('wiring', () => {
  it('the What\'s New card\'s Approve and the workspace\'s Approve share one release; neither asks the client to Confirm', () => {
    const card = read('app/api/crm/tax-review/action/route.ts')
    expect(card).toContain('approveTaxSubmission({ submissionId: submission_id')
    expect(card).not.toContain('click Confirm')
    expect(card).not.toContain('Please confirm your reviewed tax data')
    const adv = read('app/api/flows/[id]/advance/route.ts')
    expect(adv).toContain("approveTaxSubmission({ serviceDeliveryId, by: 'flow-action' })")
    expect(adv).toMatch(/result\.to_stage === 'Data Received' && fromOrder >= 45 && fromOrder < 50/)
  })
  it('the client Confirm route and button are gone', () => {
    expect(existsSync('app/api/portal/tax-confirm/route.ts')).toBe(false)
    const banner = read('components/portal/tax-banner.tsx')
    expect(banner).not.toContain('ConfirmButton')
    expect(banner).not.toContain('/api/portal/tax-confirm')
    expect(banner).toContain('stageOwnsBanner(')
  })
  it('the banner words no longer talk about a Confirm click (EN + IT)', () => {
    const i18n = read('lib/portal/i18n.ts')
    expect(i18n).not.toContain('Click Confirm to finalize your return')
    // (NOT 'taxBanner.doneDesc' — "you've confirmed your Profit & Loss and Balance Sheet" is the MMLLC financials confirmation, a different step that stays.)
    expect(i18n).not.toContain("You've confirmed your {returnLabel} {year} data")
    expect(i18n).not.toContain('Clicca Conferma per finalizzare')
    expect(i18n).not.toContain('Hai confermato i tuoi dati per la {returnLabel}')
  })
  it('the portal asks for a waiting signature only at "Sent for Signature", from the Sign tab\'s own list', () => {
    const page = read('app/portal/page.tsx')
    expect(page).toContain('tr.sd_stage === TAX_RETURN_SIGN_STAGES.sent')
    expect(page).toContain('getSignableDocuments({ selectedAccountId')
    expect(page).toContain('signatureWaiting={taxSignatureWaiting}')
  })
  it('the stage-layout migration only fires on the exact old layout and has an undo', () => {
    const up = read('scripts/migrations/20261106-2100-tax-return-approve-goes-to-data-received.sql')
    expect(up.match(/AND stage_layout = /g)).toHaveLength(3)
    // ...and the unused "Confirmed" step leaves the client's progress bar (guarded on the exact old label too)
    expect(up).toContain("SET client_label = NULL, client_label_it = NULL")
    expect(up).toContain("AND client_label = 'Confirmed' AND client_label_it = 'Confermato'")
    expect(up).toContain('"target": "Data Received"')
    expect(up).toContain('"confirm": "Mark this return as filed with the IRS?')
    expect(existsSync('scripts/migrations/20261106-2100-tax-return-approve-goes-to-data-received.UNDO.sql')).toBe(true)
  })
})
