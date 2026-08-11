/**
 * Formation re-submit gate — the pure decision (dev job ca788354).
 *
 * A formation wizard that has already been submitted can be re-opened and
 * submitted again. Production, 2026-03-23 → 2026-08-06: 8 clients did, for 15
 * extra runs of the setup chain. Two harms followed.
 *
 *  A. PHANTOM DELIVERY. The handler's existing-formation check matched
 *     `status='active'` only, so a COMPLETED formation was invisible and it
 *     minted a second Company Formation delivery for a company formed weeks
 *     earlier (Dionisie Turcanu, 2026-07-27). This needs only ONE run — he has
 *     exactly one setup job in the queue. It was never a duplicate-job bug.
 *     178 of 195 formations in production are completed, so the exposure is
 *     nearly every past client.
 *
 *  B. RE-STAMPED FORM RECORD. Where the submission token is stable (same lead,
 *     same calendar year) the re-submit upserts the SAME row and the handler
 *     re-stamped completed_at / reviewed_at with the re-run time. Daniel Janos
 *     Pasztor submitted 2026-06-25; his record read completed AND reviewed
 *     2026-07-12 — seventeen days adrift.
 *
 * THE KEY IS THE OFFER, NEVER THE CONTACT. The rule the DB already enforces
 * (uq_formation_sd_active_per_offer) is ONE IN-FLIGHT FORMATION PER
 * (CONTACT, OFFER). Roughly 11% of contacts own more than one company, so
 * keying on the person would strand a repeat client's new formation at
 * "Payment Confirmed" forever — the Davide Priori bug the stage-advance block
 * exists to prevent.
 *
 * THE UNSTAMPED MAJORITY. 179 of 195 formation deliveries carry no offer stamp,
 * because this handler never wrote one. So "the resolved offer matches nothing
 * on file" must NOT be read as "this client has no formation" — that reading
 * mints a phantom for almost every historical client, i.e. the very bug. When
 * an offer is named but matches no stamped row, the gate falls back to the
 * unstamped rows: a single UNFINISHED one is safely this same formation still
 * in flight; a FINISHED one is genuinely undecidable (it could be this client's
 * earlier company, or the formation being re-submitted) so the gate refuses to
 * guess in either direction and hands it to a human.
 *
 * Antonio's rulings, 2026-08-10:
 *  - A refused re-submit still writes the client's correction to their contact
 *    and still emails staff, saying a finished formation was re-submitted and
 *    showing what changed. Only the machinery is withheld.
 *  - It must never reset the form's reviewed status or its original completion
 *    timestamps.
 *  - Where the formation cannot be identified, fail LOUD to staff — never guess.
 *  - The undecidable path runs exactly the same side effects as refuse-finished.
 *    The ONE deliberate difference is what staff are told: a refusal asks for a
 *    review of an overwrite, while an undecidable case asks a human to decide
 *    which formation this is — it may be a genuine second company that now has
 *    no delivery at all.
 *
 * Pure function over already-fetched state, in the shape of
 * lib/portal/wizard-submit-access.ts, so every branch is testable without a DB.
 * The caller resolves the offer token (from the lead) and the formation rows.
 */

/** One Company Formation delivery belonging to the submitting contact. */
export interface FormationDeliverySnapshot {
  id: string
  stage: string | null
  status: string | null
  /** True once the formation has materialized into a real company account. */
  hasAccount: boolean
  /** The originating OFFER token. Null on the 179 historical rows. */
  sourceOfferToken: string | null
}

export interface FormationRunState {
  /** The offer this submission belongs to, resolved from the lead. Null when unresolvable. */
  offerToken: string | null
  /** Every Company Formation delivery on the contact, cancelled ones included. */
  formations: FormationDeliverySnapshot[]
  /** Whether this formation's "data received" notification already went out. */
  clientAlreadyNotified: boolean
}

export type FormationRunAction = 'create' | 'use_existing' | 'refuse_finished' | 'ambiguous'

export type FormationRunReason =
  | 'first_run'
  | 'resuming'
  | 'finished_formation_resubmitted'
  | 'formation_ambiguous'

/** The write groups this gate governs. Everything else in the handler is unconditional. */
export interface FormationRunAllowances {
  contactUpdate: boolean
  staffEmail: boolean
  deliveryCreate: boolean
  stageAdvance: boolean
  clientNotification: boolean
  /** The form record's reviewed status and completion timestamps. */
  formStatusWrite: boolean
}

export interface FormationRunDecision {
  action: FormationRunAction
  /** The delivery this run is about, when one was identified. */
  deliveryId?: string
  reason: FormationRunReason
  allow: FormationRunAllowances
}

/**
 * Withheld machinery, shared by refuse-finished and the undecidable path.
 * Antonio ruled these two run the SAME side effects; only the message differs.
 * Sharing one literal is what stops them drifting apart in a later edit.
 */
const WITHHOLD_MACHINERY: FormationRunAllowances = {
  contactUpdate: true,
  staffEmail: true,
  deliveryCreate: false,
  stageAdvance: false,
  clientNotification: false,
  formStatusWrite: false,
}

const isCancelled = (f: FormationDeliverySnapshot) => f.status === 'cancelled'

/**
 * "Finished" = past the point where a re-submit can still be absorbed safely.
 * Materialization (an account exists) is the real line: after the Articles
 * land, re-running the chain writes against a live company. A completed
 * delivery is finished for the same reason.
 */
const isFinished = (f: FormationDeliverySnapshot) => f.hasAccount || f.status === 'completed'

/** Stable ordering so a decision never depends on the row order PostgREST returned. */
const byId = (a: FormationDeliverySnapshot, b: FormationDeliverySnapshot) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

function proceed(
  delivery: FormationDeliverySnapshot | null,
  state: FormationRunState,
): FormationRunDecision {
  const allow: FormationRunAllowances = {
    contactUpdate: true,
    staffEmail: true,
    deliveryCreate: delivery === null,
    stageAdvance: true,
    // Once per formation, ever. A client who submits twice in three seconds
    // (Patrick Covelli, 2026-06-25) must not be told twice — but a run that
    // died before notifying must still deliver the first one.
    clientNotification: !state.clientAlreadyNotified,
    formStatusWrite: true,
  }
  return delivery === null
    ? { action: 'create', reason: 'first_run', allow }
    : { action: 'use_existing', deliveryId: delivery.id, reason: 'resuming', allow }
}

/** Which formation a submission or a wizard view is about. */
export interface FormationIdentification {
  /** The formation this is about, or null when none exists / none can be picked. */
  formation: FormationDeliverySnapshot | null
  /** True when two or more candidates cannot be told apart. Never guess past this. */
  ambiguous: boolean
}

/**
 * Identify WHICH formation a submission (or a wizard view) belongs to.
 *
 * Shared by the job's gate and the portal's read-only lock so the two can never
 * resolve different formations for the same client — a repeat client editing
 * company two must not be locked by company one, and the job must not refuse
 * against a sibling company's row.
 */
export function identifyFormation(
  offerToken: string | null,
  formations: FormationDeliverySnapshot[],
): FormationIdentification {
  // A cancelled formation is not evidence of anything. The four known
  // duplicates were cancelled by hand; none of them makes a client "served".
  const live = formations.filter((f) => !isCancelled(f)).slice().sort(byId)

  if (offerToken) {
    const stamped = live.filter((f) => f.sourceOfferToken === offerToken)
    if (stamped.length > 0) {
      // This offer's own formation is on file — decide on IT, never on a
      // sibling company's row. Prefer an open one; otherwise the finished one.
      return { formation: stamped.find((f) => !isFinished(f)) ?? stamped[0], ambiguous: false }
    }

    // No stamped match. Fall back to the unstamped history rather than
    // concluding "no formation exists" — that conclusion is what mints phantoms
    // (179 of 195 production formations carry no stamp).
    const unstamped = live.filter((f) => f.sourceOfferToken === null)
    if (unstamped.length === 0) return { formation: null, ambiguous: false }
    if (unstamped.length === 1 && !isFinished(unstamped[0])) {
      return { formation: unstamped[0], ambiguous: false }
    }
    // A finished unstamped formation, or several: undecidable from data.
    return { formation: null, ambiguous: true }
  }

  // No offer could be resolved at all (no lead on the wizard row — the live
  // Mohamed Essameldeen shape, 2026-08-10). With no offer named there is no
  // hint of a SECOND offer either, so a single formation is safely this one.
  if (live.length === 0) return { formation: null, ambiguous: false }
  if (live.length === 1) return { formation: live[0], ambiguous: false }
  return { formation: null, ambiguous: true }
}

export function decideFormationRun(state: FormationRunState): FormationRunDecision {
  const found = identifyFormation(state.offerToken, state.formations)

  if (found.ambiguous) {
    return { action: 'ambiguous', reason: 'formation_ambiguous', allow: WITHHOLD_MACHINERY }
  }
  if (!found.formation) return proceed(null, state)
  if (isFinished(found.formation)) {
    return {
      action: 'refuse_finished',
      deliveryId: found.formation.id,
      reason: 'finished_formation_resubmitted',
      allow: WITHHOLD_MACHINERY,
    }
  }
  return proceed(found.formation, state)
}

/**
 * Stages during which the client may still edit their submitted formation
 * wizard. Antonio's ruling 1, 2026-08-10: tax-style — editable until we begin
 * work, locked after. NOT blanket read-only at submit; a client correcting a
 * wrong passport number or date of birth before we file is a path he keeps open
 * deliberately (the same reasoning as the tax review loop).
 *
 * Work begins when we file with the state — stage 3 of the live 8-stage
 * Company Formation pipeline.
 */
export const FORMATION_EDITABLE_STAGES = ['Payment Confirmed', 'Wizard Submitted'] as const

/**
 * Whether the client may still edit this formation's wizard.
 *
 * Null formation = nothing on file yet, so nothing to protect — editable.
 * Ambiguous identification LOCKS: we will not guess which of two formations a
 * client is editing. An unreadable stage also locks — we cannot prove work has
 * not started, and a wrong lock costs the client a chat message while a wrong
 * unlock costs a silent overwrite of live company data.
 */
export function isFormationWizardEditable(
  formation: FormationDeliverySnapshot | null,
  ambiguous = false,
): boolean {
  if (ambiguous) return false
  if (!formation) return true
  if (isFinished(formation)) return false
  if (!formation.stage) return false
  return (FORMATION_EDITABLE_STAGES as readonly string[]).includes(formation.stage)
}
