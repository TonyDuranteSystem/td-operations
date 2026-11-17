/**
 * "Start a new company" relies on two existing rules, so they are pinned here (dev job bf9886a3):
 *  1. the offer's "after the EIN arrives" part reads the job that carries the offer token and ignores a CANCELLED one
 *     (lib/plan-invoices/classify.ts) — so after the swap only the NEW job can make part 2 due;
 *  2. a formation is identified by its offer and a cancelled formation is ignored (lib/portal/formation-resubmit-gate.ts) —
 *     so the client's re-submitted wizard lands on the NEW job, which is editable at its first step. (While both are live the open
 *     new job is already preferred — the old job is cancelled last for resumability, not for this routing.)
 */
import { describe, it, expect } from 'vitest'
import { stepKey, stepReached, hasActiveJob, type OfferJob } from '@/lib/plan-invoices/classify'
import { decideFormationRun, identifyFormation, isFormationWizardEditable, type FormationDeliverySnapshot } from '@/lib/portal/formation-resubmit-gate'

const TOKEN = 'offer-1'
const stepOrders = new Map([[stepKey('Company Formation', 'EIN Received'), 8]])

describe('the second part of the payment follows the new job', () => {
  const oldCancelledAtEin: OfferJob = { service_type: 'Company Formation', stage_order: 9, status: 'cancelled', source_offer_token: TOKEN }
  const newAtStart: OfferJob = { service_type: 'Company Formation', stage_order: 1, status: 'active', source_offer_token: TOKEN }
  const newAtEin: OfferJob = { ...newAtStart, stage_order: 8 }

  it('a cancelled old job past the EIN step does not make part 2 due', () => {
    const r = stepReached({ jobs: [oldCancelledAtEin, newAtStart], offerToken: TOKEN, serviceType: 'Company Formation', stage: 'EIN Received', stepOrders })
    expect(r).toEqual({ reached: false, found: true })
  })

  it('the new job reaching the step makes it due', () => {
    const r = stepReached({ jobs: [oldCancelledAtEin, newAtEin], offerToken: TOKEN, serviceType: 'Company Formation', stage: 'EIN Received', stepOrders })
    expect(r.reached).toBe(true)
  })

  it('the offer still has an active job, so the part is "waiting", not "can never be reached"', () => {
    expect(hasActiveJob({ jobs: [oldCancelledAtEin, newAtStart], offerToken: TOKEN, serviceType: 'Company Formation' })).toBe(true)
  })
})

describe('the client wizard lands on the new job', () => {
  const oldCancelled: FormationDeliverySnapshot = { id: 'a-old', stage: 'SS-4 Sent to IRS', status: 'cancelled', hasAccount: true, sourceOfferToken: TOKEN }
  const oldLive: FormationDeliverySnapshot = { ...oldCancelled, status: 'active' }
  const fresh: FormationDeliverySnapshot = { id: 'b-new', stage: 'Payment Confirmed', status: 'active', hasAccount: false, sourceOfferToken: TOKEN }

  it('identifies the new job and ignores the cancelled one', () => {
    expect(identifyFormation(TOKEN, [oldCancelled, fresh])).toEqual({ formation: fresh, ambiguous: false })
  })

  it('the new job is editable at its first step (the reopened wizard can be filled in)', () => {
    expect(isFormationWizardEditable(fresh)).toBe(true)
  })

  it('a re-submit is taken as the NEW formation (not refused as a finished one)', () => {
    const d = decideFormationRun({ offerToken: TOKEN, formations: [oldCancelled, fresh], clientAlreadyNotified: false })
    expect(d.action).toBe('use_existing')
    expect(d.deliveryId).toBe('b-new')
  })

  it('while the old job is still live the open NEW job is already the one picked — so cancelling the old job last costs the client nothing', () => {
    const d = decideFormationRun({ offerToken: TOKEN, formations: [oldLive, fresh], clientAlreadyNotified: false })
    expect(d.action).toBe('use_existing')
    expect(d.deliveryId).toBe('b-new')
  })

  it('a live old job on its own is a finished formation: a re-submit is refused (why the NEW job has to exist first)', () => {
    const onlyOld = decideFormationRun({ offerToken: TOKEN, formations: [oldLive], clientAlreadyNotified: false })
    expect(onlyOld.action).toBe('refuse_finished')
  })
})
