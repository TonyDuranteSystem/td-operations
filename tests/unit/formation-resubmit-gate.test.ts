/**
 * Formation re-submit gate — the pure decision (dev job ca788354).
 *
 * WHY THIS EXISTS. A formation wizard that has already been submitted can be
 * re-opened and submitted again. Production, 2026-03-23 → 2026-08-06: 8 clients
 * did exactly that, 15 extra runs of the setup chain. Two distinct harms:
 *
 *  A. PHANTOM DELIVERY. The handler's existing-formation check only matched
 *     `status='active'`, so a COMPLETED formation was invisible and it minted a
 *     brand-new Company Formation delivery for a company formed weeks earlier
 *     (Dionisie Turcanu, 2026-07-27, delivery bddf7da8 — since cancelled).
 *     178 of 195 formations in production are completed, so nearly every past
 *     client is a candidate. NOTE: this needs only ONE run — Turcanu has
 *     exactly one setup job in the whole queue. It is not a duplicate-job bug.
 *
 *  B. RE-STAMPED FORM RECORD. When the submission token is stable (same lead,
 *     same calendar year) the re-submit upserts the SAME row and the handler
 *     re-stamps completed_at / reviewed_at with the re-run time. Daniel Janos
 *     Pasztor submitted 2026-06-25; his record now reads completed AND reviewed
 *     2026-07-12 — SEVENTEEN DAYS of drift. Antonio's ruling 2026-08-10: a
 *     refused re-submit must never reset the reviewed status or the original
 *     completion timestamps.
 *
 * THE KEY. Never the contact. The business rule the DB already enforces
 * (uq_formation_sd_active_per_offer) is ONE IN-FLIGHT FORMATION PER
 * (CONTACT, OFFER) — deliberately not one per contact, because clients forming
 * a second company are normal here. Keying on the contact would strand a
 * repeat client's new formation at "Payment Confirmed" forever, which is the
 * Davide Priori bug the stage-advance block exists to prevent.
 *
 * WHEN THE OFFER CANNOT BE RESOLVED (no lead on the wizard row — the live
 * Mohamed Essameldeen shape, 2026-08-10) the gate falls back ONLY where there
 * is no ambiguity, and otherwise stops and tells staff. Antonio: "fail LOUD to
 * staff, never guess."
 *
 * This module is a PURE function over already-fetched state — same shape as
 * lib/portal/wizard-submit-access.ts — so every branch is testable without a DB.
 */

import { describe, it, expect } from 'vitest'
import {
  decideFormationRun,
  identifyFormation,
  isFormationWizardEditable,
  type FormationRunState,
  type FormationDeliverySnapshot,
} from '@/lib/portal/formation-resubmit-gate'

// ── Fixture helpers ──

const sd = (over: Partial<FormationDeliverySnapshot> = {}): FormationDeliverySnapshot => ({
  id: 'SD-1',
  stage: 'Wizard Submitted',
  status: 'active',
  hasAccount: false,
  sourceOfferToken: 'offer-alpha-2026',
  ...over,
})

const state = (over: Partial<FormationRunState> = {}): FormationRunState => ({
  offerToken: 'offer-alpha-2026',
  formations: [],
  clientAlreadyNotified: false,
  ...over,
})

/** The four write groups the gate governs. */
const ALL_WRITES = [
  'contactUpdate',
  'staffEmail',
  'deliveryCreate',
  'stageAdvance',
  'clientNotification',
  'formStatusWrite',
] as const

describe('decideFormationRun — first run (nothing exists yet)', () => {
  it('creates the delivery and permits every write', () => {
    const d = decideFormationRun(state())
    expect(d.action).toBe('create')
    for (const w of ALL_WRITES) {
      expect(d.allow[w], `${w} must be allowed on a first run`).toBe(true)
    }
  })

  it('creates even when the offer cannot be resolved, IF the client has no formation at all', () => {
    // A brand-new client reaching the wizard without ?lead= is not ambiguous:
    // there is nothing to confuse it with. This is not a guess.
    const d = decideFormationRun(state({ offerToken: null }))
    expect(d.action).toBe('create')
    expect(d.allow.deliveryCreate).toBe(true)
  })
})

describe('decideFormationRun — re-run of an UNFINISHED formation (skip-done-do-missing)', () => {
  // Antonio's ruling: a failed setup must always be re-runnable to completion.
  // Refusal is ONLY for the finished case. The queue can also re-enter the
  // handler on retry, so this path must stay open regardless of who drove it.

  it('reuses the existing delivery instead of creating a second one', () => {
    const existing = sd({ id: 'SD-LIVE', stage: 'Payment Confirmed' })
    const d = decideFormationRun(state({ formations: [existing] }))
    expect(d.action).toBe('use_existing')
    expect(d.deliveryId).toBe('SD-LIVE')
    expect(d.allow.deliveryCreate).toBe(false)
  })

  it('still allows the stage advance — an SD stuck at Payment Confirmed must move', () => {
    // Davide Priori, 2026-06-24: the "already exists" branch skipped and left
    // the delivery stuck at Payment Confirmed forever.
    const d = decideFormationRun(state({ formations: [sd({ stage: 'Payment Confirmed' })] }))
    expect(d.allow.stageAdvance).toBe(true)
  })

  it('still writes the contact and the form status on a legitimate re-run', () => {
    const d = decideFormationRun(state({ formations: [sd()] }))
    expect(d.allow.contactUpdate).toBe(true)
    expect(d.allow.formStatusWrite).toBe(true)
  })
})

describe('decideFormationRun — the double-click (client notification fires ONCE per formation)', () => {
  // Patrick Covelli, 2026-06-25 08:08:39 and 08:08:42 — two submits three
  // seconds apart, both ran. Pasztor and Covelli each received the
  // "Formation data received!" portal notification three times.
  // The finished-gate cannot catch this: the formation was NOT finished.

  it('suppresses a second client notification when one was already sent', () => {
    const d = decideFormationRun(state({ formations: [sd()], clientAlreadyNotified: true }))
    expect(d.allow.clientNotification).toBe(false)
  })

  it('still sends the FIRST notification when an earlier run died before sending it', () => {
    // Skip what is done, do what is missing — a run that failed before the
    // notification must still deliver it.
    const d = decideFormationRun(state({ formations: [sd()], clientAlreadyNotified: false }))
    expect(d.allow.clientNotification).toBe(true)
  })
})

describe('decideFormationRun — REFUSE: the formation is finished', () => {
  const finishedCases: Array<[string, FormationDeliverySnapshot]> = [
    ['completed', sd({ status: 'completed', stage: 'EIN Received' })],
    ['materialized into a real company', sd({ status: 'active', hasAccount: true, stage: 'SS-4 Prepared' })],
    ['completed AND materialized (the Turcanu shape)', sd({ status: 'completed', hasAccount: true, stage: 'EIN Received' })],
  ]

  for (const [label, formation] of finishedCases) {
    describe(`when the formation is ${label}`, () => {
      const d = () => decideFormationRun(state({ formations: [formation] }))

      it('refuses', () => {
        expect(d().action).toBe('refuse_finished')
      })

      it('creates NO delivery — this is the phantom', () => {
        expect(d().allow.deliveryCreate).toBe(false)
      })

      it('advances NO stage', () => {
        expect(d().allow.stageAdvance).toBe(false)
      })

      it('notifies the CLIENT of nothing', () => {
        expect(d().allow.clientNotification).toBe(false)
      })

      it('does NOT reset the form status or its completion timestamps', () => {
        // Antonio, 2026-08-10. Pasztor's record drifted 17 days.
        expect(d().allow.formStatusWrite).toBe(false)
      })

      it('STILL writes the client correction to the contact', () => {
        // Antonio's ruling: a correction must not vanish silently.
        expect(d().allow.contactUpdate).toBe(true)
      })

      it('STILL emails staff, so the overwrite gets human review', () => {
        expect(d().allow.staffEmail).toBe(true)
      })

      it('tells the staff email WHY, so it reads as a re-submit not a new formation', () => {
        expect(d().reason).toBe('finished_formation_resubmitted')
      })
    })
  }
})

describe('decideFormationRun — the SECOND COMPANY must not be blocked', () => {
  // ~11% of contacts own more than one company. Keying on the contact instead
  // of the offer would refuse here and strand the new formation forever.

  it('creates a new delivery when the finished one belongs to a DIFFERENT offer', () => {
    const firstCompany = sd({
      id: 'SD-COMPANY-ONE',
      sourceOfferToken: 'offer-alpha-2026',
      status: 'completed',
      hasAccount: true,
      stage: 'EIN Received',
    })
    const d = decideFormationRun(state({ offerToken: 'offer-beta-2026', formations: [firstCompany] }))
    expect(d.action).toBe('create')
    expect(d.allow.deliveryCreate).toBe(true)
    expect(d.allow.stageAdvance).toBe(true)
  })

  it('picks the delivery for THIS offer, never an arbitrary one', () => {
    // The old lookup took .limit(1) with no ordering, so once two rows matched
    // the refuse/advance decision was a coin flip.
    const companyOne = sd({ id: 'SD-ONE', sourceOfferToken: 'offer-alpha-2026', status: 'completed', hasAccount: true })
    const companyTwo = sd({ id: 'SD-TWO', sourceOfferToken: 'offer-beta-2026', stage: 'Payment Confirmed' })
    const d = decideFormationRun(state({ offerToken: 'offer-beta-2026', formations: [companyOne, companyTwo] }))
    expect(d.action).toBe('use_existing')
    expect(d.deliveryId).toBe('SD-TWO')
  })

  it('is order-independent — the same input shuffled decides the same way', () => {
    const companyOne = sd({ id: 'SD-ONE', sourceOfferToken: 'offer-alpha-2026', status: 'completed', hasAccount: true })
    const companyTwo = sd({ id: 'SD-TWO', sourceOfferToken: 'offer-beta-2026', stage: 'Payment Confirmed' })
    const a = decideFormationRun(state({ offerToken: 'offer-beta-2026', formations: [companyOne, companyTwo] }))
    const b = decideFormationRun(state({ offerToken: 'offer-beta-2026', formations: [companyTwo, companyOne] }))
    expect(a).toEqual(b)
  })
})

describe('decideFormationRun — cancelled formations are not evidence', () => {
  it('ignores a cancelled formation and creates', () => {
    // The four known duplicates were cancelled by hand. A cancelled row must
    // never make the client look "already served".
    const d = decideFormationRun(state({ formations: [sd({ status: 'cancelled', stage: 'Cancelled' })] }))
    expect(d.action).toBe('create')
  })

  it('does not treat a cancelled formation as the ambiguity tiebreaker', () => {
    const live = sd({ id: 'SD-LIVE', sourceOfferToken: null, stage: 'Payment Confirmed' })
    const dead = sd({ id: 'SD-DEAD', sourceOfferToken: null, status: 'cancelled' })
    const d = decideFormationRun(state({ offerToken: null, formations: [live, dead] }))
    // Exactly ONE non-cancelled → unambiguous, not 'ambiguous'.
    expect(d.action).toBe('use_existing')
    expect(d.deliveryId).toBe('SD-LIVE')
  })
})

describe('decideFormationRun — no resolvable offer: fall back only where unambiguous', () => {
  it('refuses when the single formation is finished (the live Essameldeen shape)', () => {
    // 2026-08-10: fresh wizard row, no lead, and an active formation already
    // materialized into a real company at SS-4 Prepared.
    const materialized = sd({ sourceOfferToken: 'offer-alpha-2026', hasAccount: true, stage: 'SS-4 Prepared' })
    const d = decideFormationRun(state({ offerToken: null, formations: [materialized] }))
    expect(d.action).toBe('refuse_finished')
    expect(d.allow.deliveryCreate).toBe(false)
    expect(d.allow.formStatusWrite).toBe(false)
  })

  it('proceeds when the single formation is unfinished', () => {
    const d = decideFormationRun(state({ offerToken: null, formations: [sd({ stage: 'Payment Confirmed' })] }))
    expect(d.action).toBe('use_existing')
  })

  it('STOPS and flags staff when the client has two open formations — never guesses', () => {
    const one = sd({ id: 'SD-ONE', sourceOfferToken: 'offer-alpha-2026', stage: 'Payment Confirmed' })
    const two = sd({ id: 'SD-TWO', sourceOfferToken: 'offer-beta-2026', stage: 'Payment Confirmed' })
    const d = decideFormationRun(state({ offerToken: null, formations: [one, two] }))
    expect(d.action).toBe('ambiguous')
    expect(d.deliveryId).toBeUndefined()
  })

  it('the ambiguous case is LOUD to staff and silent to the client', () => {
    const one = sd({ id: 'SD-ONE', sourceOfferToken: 'offer-alpha-2026' })
    const two = sd({ id: 'SD-TWO', sourceOfferToken: 'offer-beta-2026' })
    const d = decideFormationRun(state({ offerToken: null, formations: [one, two] }))
    expect(d.allow.staffEmail).toBe(true)
    expect(d.reason).toBe('formation_ambiguous')
    expect(d.allow.clientNotification).toBe(false)
    expect(d.allow.deliveryCreate).toBe(false)
    expect(d.allow.stageAdvance).toBe(false)
    expect(d.allow.formStatusWrite).toBe(false)
  })

  it('still writes the contact when ambiguous — the correction is not thrown away', () => {
    const one = sd({ id: 'SD-ONE', sourceOfferToken: 'offer-alpha-2026' })
    const two = sd({ id: 'SD-TWO', sourceOfferToken: 'offer-beta-2026' })
    const d = decideFormationRun(state({ offerToken: null, formations: [one, two] }))
    expect(d.allow.contactUpdate).toBe(true)
  })
})

describe('decideFormationRun — UNSTAMPED history (the majority of production)', () => {
  // 179 of 195 formation deliveries carry NO offer stamp, because the handler
  // never wrote one. So "the resolved offer matches no stamped row" must NOT
  // be read as "this client has no formation" — that reading would mint a
  // phantom for almost every historical client, i.e. the exact bug being fixed.
  //
  // The rule: fall back to the unstamped non-cancelled rows, and let their
  // state decide. An unfinished one is almost certainly this same formation
  // still in flight. A FINISHED one is genuinely undecidable from data — it
  // could be this client's earlier company (a legitimate second formation) or
  // the very formation being re-submitted — so the gate refuses to guess and
  // hands it to staff. Never mint, never silently block.

  it('adopts a single UNFINISHED unstamped formation as this one', () => {
    const unstamped = sd({ id: 'SD-UNSTAMPED', sourceOfferToken: null, stage: 'Payment Confirmed' })
    const d = decideFormationRun(state({ offerToken: 'offer-beta-2026', formations: [unstamped] }))
    expect(d.action).toBe('use_existing')
    expect(d.deliveryId).toBe('SD-UNSTAMPED')
  })

  it('will NOT mint a second delivery beside a finished unstamped formation', () => {
    // This is the Turcanu class as it would look for the 179 unstamped rows.
    const unstamped = sd({ id: 'SD-UNSTAMPED', sourceOfferToken: null, status: 'completed', hasAccount: true })
    const d = decideFormationRun(state({ offerToken: 'offer-beta-2026', formations: [unstamped] }))
    expect(d.action).not.toBe('create')
    expect(d.allow.deliveryCreate).toBe(false)
  })

  it('hands the finished-unstamped case to staff rather than guessing either way', () => {
    // Could be a legitimate second company; could be a re-submit of this one.
    // Data cannot tell them apart, so a human does.
    const unstamped = sd({ id: 'SD-UNSTAMPED', sourceOfferToken: null, status: 'completed', hasAccount: true })
    const d = decideFormationRun(state({ offerToken: 'offer-beta-2026', formations: [unstamped] }))
    expect(d.action).toBe('ambiguous')
    expect(d.allow.staffEmail).toBe(true)
    expect(d.allow.clientNotification).toBe(false)
    expect(d.allow.formStatusWrite).toBe(false)
  })

  it('runs EXACTLY the side effects the refuse-finished path runs — no silent divergence', () => {
    // Antonio, 2026-08-10: ruling 2 applies to the undecidable path exactly as
    // to refuse-finished. The client's correction lands, staff are told; only
    // the machinery is withheld. Asserting the whole allow-map against the
    // refuse-finished allow-map means a future edit cannot quietly split them.
    const unstamped = sd({ id: 'SD-UNSTAMPED', sourceOfferToken: null, status: 'completed', hasAccount: true })
    const undecidable = decideFormationRun(state({ offerToken: 'offer-beta-2026', formations: [unstamped] }))

    const stampedFinished = sd({ status: 'completed', hasAccount: true })
    const refused = decideFormationRun(state({ formations: [stampedFinished] }))

    expect(undecidable.allow).toEqual(refused.allow)
    expect(undecidable.allow).toEqual({
      contactUpdate: true,
      staffEmail: true,
      deliveryCreate: false,
      stageAdvance: false,
      clientNotification: false,
      formStatusWrite: false,
    })
  })

  it('but tells staff a DIFFERENT thing — this one may need a delivery created by hand', () => {
    // The single deliberate difference. Refuse-finished asks for a review of an
    // overwrite; undecidable asks a human to decide which formation this is,
    // because it may be a genuine second company that now has no delivery.
    const unstamped = sd({ sourceOfferToken: null, status: 'completed', hasAccount: true })
    const undecidable = decideFormationRun(state({ offerToken: 'offer-beta-2026', formations: [unstamped] }))
    const refused = decideFormationRun(state({ formations: [sd({ status: 'completed', hasAccount: true })] }))

    expect(undecidable.reason).toBe('formation_ambiguous')
    expect(refused.reason).toBe('finished_formation_resubmitted')
    expect(undecidable.reason).not.toBe(refused.reason)
  })

  it('a STAMPED match for a different offer still lets the second company through', () => {
    // Stamping is what buys back the clean second-company path. Once the first
    // formation carries its offer, a new offer is unambiguous again.
    const stampedFirst = sd({
      id: 'SD-ONE',
      sourceOfferToken: 'offer-alpha-2026',
      status: 'completed',
      hasAccount: true,
    })
    const d = decideFormationRun(state({ offerToken: 'offer-beta-2026', formations: [stampedFirst] }))
    expect(d.action).toBe('create')
  })
})

// ── The wizard read-only lock (Antonio's ruling 1, 2026-08-10) ──
// Tax-style: editable until we begin work, locked after. NOT blanket
// read-only at submit — a client fixing a wrong passport or date before we
// file is a path Antonio deliberately keeps open. Work begins at "Filed with
// State" (stage 3 of 8 in the live Company Formation pipeline).
//
// It shares identifyFormation with the gate, so a repeat client's two
// formations can never be confused by one and matched by the other.

describe('isFormationWizardEditable — editable until we begin work', () => {
  it('is editable before anything has been filed', () => {
    expect(isFormationWizardEditable(sd({ stage: 'Payment Confirmed' }))).toBe(true)
    expect(isFormationWizardEditable(sd({ stage: 'Wizard Submitted' }))).toBe(true)
  })

  it('LOCKS from the moment we file with the state onward', () => {
    for (const stage of [
      'Filed with State',
      'Articles Received',
      'SS-4 Prepared',
      'SS-4 Signed',
      'SS-4 Sent to IRS',
      'EIN Received',
    ]) {
      expect(isFormationWizardEditable(sd({ stage })), `${stage} must be locked`).toBe(false)
    }
  })

  it('LOCKS once the formation has become a real company', () => {
    expect(isFormationWizardEditable(sd({ stage: 'Wizard Submitted', hasAccount: true }))).toBe(false)
  })

  it('LOCKS a completed formation', () => {
    expect(isFormationWizardEditable(sd({ stage: 'Wizard Submitted', status: 'completed' }))).toBe(false)
  })

  it('is editable when there is no formation on file yet', () => {
    // Still filling in the first one — nothing to protect.
    expect(isFormationWizardEditable(null)).toBe(true)
  })

  it('LOCKS when the stage cannot be read', () => {
    // Cannot prove we have not started. A wrong lock costs the client a chat
    // message; a wrong unlock costs a silent overwrite of live company data.
    expect(isFormationWizardEditable(sd({ stage: null }))).toBe(false)
  })
})

describe('identifyFormation — the lock and the gate must never disagree', () => {
  it('picks this offer\'s formation, not a sibling company\'s', () => {
    const one = sd({ id: 'SD-ONE', sourceOfferToken: 'offer-alpha-2026', status: 'completed', hasAccount: true })
    const two = sd({ id: 'SD-TWO', sourceOfferToken: 'offer-beta-2026', stage: 'Wizard Submitted' })
    expect(identifyFormation('offer-beta-2026', [one, two]).formation?.id).toBe('SD-TWO')
  })

  it('a repeat client editing company two is NOT locked by company one being filed', () => {
    const filedFirst = sd({ id: 'SD-ONE', sourceOfferToken: 'offer-alpha-2026', stage: 'EIN Received', status: 'completed', hasAccount: true })
    const newSecond = sd({ id: 'SD-TWO', sourceOfferToken: 'offer-beta-2026', stage: 'Wizard Submitted' })
    const found = identifyFormation('offer-beta-2026', [filedFirst, newSecond])
    expect(found.ambiguous).toBe(false)
    expect(isFormationWizardEditable(found.formation)).toBe(true)
  })

  it('reports ambiguity rather than picking one when they cannot be told apart', () => {
    const one = sd({ id: 'SD-ONE', sourceOfferToken: null, stage: 'Wizard Submitted' })
    const two = sd({ id: 'SD-TWO', sourceOfferToken: null, stage: 'Wizard Submitted' })
    const found = identifyFormation(null, [one, two])
    expect(found.ambiguous).toBe(true)
    expect(found.formation).toBeNull()
  })

  it('an ambiguous identification LOCKS — never guesses which one to open', () => {
    const found = identifyFormation(null, [
      sd({ id: 'SD-ONE', sourceOfferToken: null }),
      sd({ id: 'SD-TWO', sourceOfferToken: null }),
    ])
    expect(isFormationWizardEditable(found.formation, found.ambiguous)).toBe(false)
  })

  it('the gate and the lock resolve the SAME formation for the same input', () => {
    const one = sd({ id: 'SD-ONE', sourceOfferToken: 'offer-alpha-2026', stage: 'Payment Confirmed' })
    const two = sd({ id: 'SD-TWO', sourceOfferToken: 'offer-beta-2026', stage: 'Payment Confirmed' })
    const gate = decideFormationRun(state({ offerToken: 'offer-beta-2026', formations: [one, two] }))
    const lock = identifyFormation('offer-beta-2026', [one, two])
    expect(lock.formation?.id).toBe(gate.deliveryId)
  })
})
