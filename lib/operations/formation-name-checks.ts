/**
 * Formation Name Command Center — server operations over
 * `service_deliveries.name_checks` (JSONB). Backs POST /api/flows/[id]/name-check
 * and the decision-response hook. The column is new (not in generated types) so
 * reads/writes use an untyped accessor.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { isItalian } from '@/lib/locale'
import { FORMATION_STATE_NAMES, formationStateFromWizardData, normalizeFormationState, resolveFormationStateCode } from '@/lib/formation/states'
import { formationStateForClient } from '@/lib/formation/state-lookup'
import {
  initNameChecksFromWizard,
  parseProposedNames,
  allNamesDead,
  addStaffName,
  addClientNames,
  nameActionProblem,
  nameDedupeKey,
  type GuardedNameAction,
  type NameCheck,
  type NameCheckStatus,
} from '@/lib/flows/name-checks'
import { createDecisionRequest } from '@/lib/operations/decision-request'
import { buildFlowTopic, deriveFlowYear } from '@/lib/flows/resolve-flows'
import { notifyClientOfAdminMessage } from '@/lib/portal/notifications'
import type { DecisionRequest } from '@/lib/decisions'

// name_checks is not in the generated DB types yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sd = () => (supabaseAdmin as any).from('service_deliveries')

export type NameAction =
  | 'mark_available'
  | 'mark_not_available'
  | 'send_to_client'
  | 'mark_filed'
  | 'mark_sos_rejected'
  // Not tied to a specific candidate — asks the client for a fresh set of names
  // when none of the current ones are viable (all unavailable / rejected).
  | 'request_new_names'
  // Staff types a candidate name directly (client sent one by email/chat).
  // Not tied to an existing row; carries `name` instead of an index.
  | 'add_name'
  // Takes a name back from the client (waiting for an answer that is not coming,
  // or sent by mistake): sent_to_client → available, and the open approval
  // request is cancelled so a late answer can no longer flip it.
  | 'withdraw'

interface SdRow {
  id: string
  contact_id: string | null
  account_id: string | null
  name_checks: NameCheck[] | null
  service_type: string | null
  due_date: string | null
  stage_entered_at: string | null
  created_at: string | null
  stage: string | null
  updated_at: string | null
  /** active / completed / cancelled … — outward actions refuse a finished case. */
  status?: string | null
}

/** A finished case (completed / cancelled) must not message the client or be moved by a stale tab. */
function isClosedCase(row: SdRow): boolean {
  return row.status === 'completed' || row.status === 'cancelled'
}

async function loadSd(sdId: string): Promise<SdRow | null> {
  // NOTE: state_of_formation lives on `accounts`, NOT service_deliveries —
  // selecting it here errors the whole query (and silently empties name_checks).
  // service_type + the date columns feed the flow-chat topic/year (send_to_client).
  const { data } = await sd()
    .select('id, contact_id, account_id, name_checks, service_type, due_date, stage_entered_at, created_at, stage, updated_at, status')
    .eq('id', sdId)
    .maybeSingle()
  return (data as SdRow | null) ?? null
}

interface WriteResult {
  ok: boolean
  conflict?: boolean
  error?: string
  /** The `updated_at` this write stamped — the version the NEXT guarded write must expect. */
  updatedAt?: string
}

/**
 * Save the name list. With `expectedUpdatedAt` it only writes if nobody else
 * changed the case since we read it (two staff, or staff + a client answer at
 * the same moment, used to silently overwrite each other) — a stale save comes
 * back as `conflict`. The write error is no longer swallowed.
 */
async function writeNameChecks(sdId: string, checks: NameCheck[], expectedUpdatedAt?: string | null): Promise<WriteResult> {
  const stamp = new Date().toISOString()
  let q = sd().update({ name_checks: checks, updated_at: stamp }).eq('id', sdId)
  if (expectedUpdatedAt) q = q.eq('updated_at', expectedUpdatedAt)
  const { data, error } = await q.select('id')
  if (error) {
    console.error(`writeNameChecks failed for SD ${sdId}:`, error.message)
    return { ok: false, conflict: false, error: 'Could not save the names — please try again.' }
  }
  if (expectedUpdatedAt && (!Array.isArray(data) || data.length === 0)) {
    return { ok: false, conflict: true, error: 'The names changed while you were working (someone else or the client just acted). Reload the page and try again.' }
  }
  return { ok: true, updatedAt: stamp }
}

/**
 * Resolve the formation state of an in-flight SD for the CLIENT-FACING
 * availability message: the account's state, else the wizard → form submission →
 * signed offer chain (WS-B scope amendment — before it, a signed-Wyoming deal
 * told the client "available in New Mexico" here), else "New Mexico".
 * Returns the display NAME ("Wyoming"), normalizing code-shaped values.
 */
async function resolveState(row: SdRow): Promise<string> {
  if (row.account_id) {
    const { data: acct } = await supabaseAdmin
      .from('accounts')
      .select('state_of_formation')
      .eq('id', row.account_id)
      .maybeSingle()
    if (acct?.state_of_formation) {
      // Accounts hold both full names ("Wyoming") and code forms ("WY") —
      // normalize to the display name; unknown values pass through verbatim.
      const code = normalizeFormationState(acct.state_of_formation)
      return code ? FORMATION_STATE_NAMES[code] : (acct.state_of_formation as string)
    }
  }
  if (row.contact_id) {
    const { data: wp } = await supabaseAdmin
      .from('wizard_progress')
      .select('data')
      .eq('contact_id', row.contact_id)
      .eq('wizard_type', 'formation')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const { data: subRow } = await supabaseAdmin
      .from('formation_submissions')
      .select('state')
      .eq('contact_id', row.contact_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const resolution = resolveFormationStateCode({
      wizardState: formationStateFromWizardData((wp?.data ?? null) as Record<string, unknown> | null),
      submissionState: (subRow as { state?: string | null } | null)?.state,
      offerState: await formationStateForClient({ contactId: row.contact_id }),
    })
    if (resolution.source !== 'default') return FORMATION_STATE_NAMES[resolution.code]
  }
  return 'New Mexico'
}

/**
 * Post a heads-up message to the flow chat when a name is sent to the client for
 * approval, so the client sees it in their portal chat alongside the decision
 * request. Mirrors the EIN-save flow-chat pattern (app/api/flows/[id]/save-ein).
 * Best-effort: the decision request is already created — a chat failure here must
 * NOT fail the staff action.
 */
async function sendNameProposalChatMessage(row: SdRow, displayName: string, state: string, senderId: string | null): Promise<void> {
  // portal_messages.sender_id is NOT NULL — without a real sender the insert
  // throws and the best-effort catch below silently drops the message (the bug
  // that left the name-proposal chat note never posting). Skip rather than null.
  if (!senderId) return
  try {
    let language: 'en' | 'it' = 'en'
    if (row.contact_id) {
      const { data: contact } = await supabaseAdmin
        .from('contacts')
        .select('language')
        .eq('id', row.contact_id)
        .maybeSingle()
      // contacts.language is free text ("Italian", not "it") — normalize.
      if (isItalian(contact?.language)) language = 'it'
    }

    const message =
      language === 'it'
        ? `Abbiamo verificato i nomi della tua LLC e ${displayName} è disponibile in ${state}. Ti abbiamo inviato una richiesta di conferma — controlla il tuo portale.`
        : `We checked your LLC names and ${displayName} is available in ${state}. We've sent you a request to confirm — please check your portal.`

    const topic = buildFlowTopic(row.service_type, deriveFlowYear(row)) || null

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service_delivery_id not in generated types
    await (supabaseAdmin as any).from('portal_messages').insert({
      account_id: row.account_id,
      contact_id: row.contact_id,
      service_delivery_id: row.id,
      topic,
      sender_type: 'admin',
      sender_id: senderId,
      message,
    })

    notifyClientOfAdminMessage({
      account_id: row.account_id,
      contact_id: row.contact_id,
      topic,
      messagePreview: message,
    }).catch(() => {})
  } catch {
    /* best-effort — the decision request is already created + the name marked sent */
  }
}

/**
 * Read the SD's name_checks; if absent/empty, initialize from the latest
 * formation wizard submission for the SD's contact, persist, and return.
 */
export async function getOrInitNameChecks(sdId: string): Promise<NameCheck[]> {
  return (await loadWithChecks(sdId))?.checks ?? []
}

/**
 * ONE read of the case: the name list AND the version stamp (`updated_at`) come
 * from the same row, so a guarded save can never compare against a stamp that is
 * newer than the list it read (a client answer landing between two reads used to
 * pass the guard and be silently overwritten). When the list is empty it is
 * seeded once, then re-read so the stamp matches the seeding write.
 */
async function loadWithChecks(sdId: string): Promise<{ row: SdRow; checks: NameCheck[] } | null> {
  let row = await loadSd(sdId)
  if (!row) return null
  if (Array.isArray(row.name_checks) && row.name_checks.length > 0) return { row, checks: row.name_checks }
  const seeded = await seedChecksFor(row)
  if (seeded.length === 0) return { row, checks: [] }
  await writeNameChecks(sdId, seeded)
  row = (await loadSd(sdId)) ?? row
  return { row, checks: Array.isArray(row.name_checks) && row.name_checks.length > 0 ? row.name_checks : seeded }
}

/** First-time candidates from the contact's formation wizard (falling back to the formation form submission). */
async function seedChecksFor(row: SdRow): Promise<NameCheck[]> {
  let checks: NameCheck[] = []
  if (row.contact_id) {
    const { data: wp } = await supabaseAdmin
      .from('wizard_progress')
      .select('data')
      .eq('contact_id', row.contact_id)
      .eq('wizard_type', 'formation')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    let wizardData = (wp?.data ?? null) as Record<string, unknown> | null
    // FALLBACK (dev job 9a9c5cf5): a wizard_progress write can fail
    // silently (2026-08-27 missing-column incident being the proven
    // case — Francesco Lussignoli, live production: this left the LLC
    // Name Approval panel with NO candidate names at all, blocking
    // staff from taking the very next action). formation_submissions
    // carries the same llc_name_1/2/3 fields independently.
    if (!wizardData) {
      const { data: sub } = await supabaseAdmin
        .from('formation_submissions')
        .select('submitted_data')
        .eq('contact_id', row.contact_id)
        .in('status', ['completed', 'reviewed'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      wizardData = (sub?.submitted_data ?? null) as Record<string, unknown> | null
    }
    checks = initNameChecksFromWizard(wizardData)
  }
  return checks
}

export interface NameActionResult {
  ok: boolean
  error?: string
  name_checks?: NameCheck[]
}

const SIMPLE_STATUS: Partial<Record<NameAction, NameCheckStatus>> = {
  mark_available: 'available',
  mark_not_available: 'not_available',
  mark_filed: 'filed',
}

async function cancelPendingNewNamesRequestsOnce(sdId: string): Promise<{ error: { message: string } | null }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client_decision_requests not in generated types
  return (supabaseAdmin as any)
    .from('client_decision_requests')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('service_delivery_id', sdId)
    .eq('status', 'pending')
    .eq('request_type', 'text_input')
    // Only the "propose new names" asks — never another text question open on the same case.
    .eq('options->name_check->>kind', 'new_names')
}

/**
 * Cancel any still-pending "new names" (text_input) request for this SD —
 * called both before creating a fresh one (so the client never sees TWO
 * name-request windows at once) and the moment a candidate is sent back to
 * the client for approval (so a stale "none of your names work" ask is never
 * left showing once one of them actually did). Exported for the one-time
 * production backfill script (scripts/backfill-stale-name-request-cancellations.ts).
 *
 * Retries once on failure, then reports to the system-error dashboard rather
 * than only logging (2026-09-11, senior-engineer council catch): a swallowed
 * failure here leaves the stale request live with zero signal — silently
 * reproducing the exact 2026-09-10 Lead Lift LLC incident this file exists to
 * close, just triggered by a transient write failure instead of a missing
 * guard. Mirrors the retry-then-report pattern already used for the same
 * failure class in app/api/flows/[id]/upload-document/route.ts.
 */
export async function cancelPendingNewNamesRequests(sdId: string): Promise<void> {
  let { error } = await cancelPendingNewNamesRequestsOnce(sdId)
  if (error) {
    console.error(`cancelPendingNewNamesRequests failed for SD ${sdId}, retrying once:`, error.message)
    ;({ error } = await cancelPendingNewNamesRequestsOnce(sdId))
  }
  if (error) {
    console.error(`cancelPendingNewNamesRequests failed twice for SD ${sdId}:`, error.message)
    try {
      const { reportSystemError } = await import('@/lib/system-errors')
      await reportSystemError({
        source: 'server',
        route: 'lib/operations/formation-name-checks.ts:cancelPendingNewNamesRequests',
        message: `Failed to cancel a stale "New LLC Names Needed" request twice for SD ${sdId}: ${error.message}`,
        context: { service_delivery_id: sdId },
      })
    } catch {
      /* best-effort — never let error reporting mask the original failure */
    }
  }
}

/**
 * Cancel ONE still-pending decision request (the approval card of a name staff
 * withdrew). Only a pending request is touched — an answered one stays as it is.
 * Retries once, then reports to the error dashboard (same pattern as
 * cancelPendingNewNamesRequests): a swallowed failure would leave a card on the
 * client's portal for a name that is no longer waiting.
 */
async function cancelDecisionRequestById(requestId: string, sdId: string): Promise<void> {
  const run = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client_decision_requests not in generated types
    (supabaseAdmin as any)
      .from('client_decision_requests')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', requestId)
      .eq('status', 'pending')
  let { error } = await run()
  if (error) ({ error } = await run())
  if (error) {
    console.error(`cancelDecisionRequestById failed for request ${requestId}:`, error.message)
    try {
      const { reportSystemError } = await import('@/lib/system-errors')
      await reportSystemError({
        source: 'server',
        route: 'lib/operations/formation-name-checks.ts:cancelDecisionRequestById',
        message: `Could not cancel the approval request ${requestId} of a withdrawn name (SD ${sdId}): ${error.message}`,
        context: { service_delivery_id: sdId, decision_request_id: requestId },
      })
    } catch {
      /* best-effort */
    }
  }
}

/** Apply a staff name action; creates decision requests for send/sos-reject. */
export async function handleNameAction(params: {
  sdId: string
  action: NameAction
  nameIndex: number
  /** Only for add_name: the LLC name staff typed. */
  name?: string
  actor: string
  /** Auth user UUID — used as portal_messages.sender_id for the flow chat note
   *  (that column is NOT NULL, so without it the heads-up message is dropped). */
  actorId?: string | null
}): Promise<NameActionResult> {
  // ONE read: the list and its version stamp come from the same row (and any
  // first-time seeding is re-read), so the guarded saves below compare against
  // the version of the list this action actually saw. (If the stamp is missing
  // the guard is simply skipped — never blocks on a missing stamp.)
  const loaded = await loadWithChecks(params.sdId)
  if (!loaded) return { ok: false, error: 'Service delivery not found.' }
  const { row, checks } = loaded
  const fresh = row
  const expectedUpdatedAt = fresh.updated_at ?? null

  // add_name: staff types a candidate directly. Only while names are being
  // selected (the server enforces it — the panel hiding the box is not enough),
  // and it retracts any open "propose new names" ask, because that ask is moot
  // the moment staff supply a name (same rule send_to_client already follows).
  if (params.action === 'add_name') {
    if (fresh.stage !== 'Wizard Submitted') {
      return { ok: false, error: 'Names can only be added while the case is at the name-selection step (Wizard Submitted).' }
    }
    const added = addStaffName(checks, params.name, new Date().toISOString())
    if (!added.ok) return { ok: false, error: added.error }
    const saved = await writeNameChecks(params.sdId, added.checks, expectedUpdatedAt)
    if (!saved.ok) return { ok: false, error: saved.error }
    await cancelPendingNewNamesRequests(params.sdId)
    return { ok: true, name_checks: added.checks }
  }

  // request_new_names is not tied to a specific candidate — it asks the client
  // for a fresh set when none of the current names are viable. Handle before the
  // per-name entry lookup (no nameIndex required).
  if (params.action === 'request_new_names') {
    if (isClosedCase(row)) return { ok: false, error: 'This case is already finished — nothing can be asked of the client.' }
    // Server-side enforcement of the same rule the staff panel's button
    // visibility already follows — previously the API accepted this action
    // unconditionally, which is exactly how the 2026-09-10 Lead Lift LLC
    // incident's stray request got created (fired while a candidate was
    // still unchecked).
    if (!allNamesDead(checks)) {
      return { ok: false, error: 'Not every name has been checked yet — mark the rest available or not available before asking the client for new names.' }
    }
    await cancelPendingNewNamesRequests(params.sdId)
    const created = await createDecisionRequest({
      service_delivery_id: params.sdId,
      request_type: 'text_input',
      title: 'New LLC Names Needed',
      message: `Unfortunately none of your proposed LLC names are available. Please propose 3 new LLC names so we can check their availability.`,
      message_it: `Purtroppo nessuno dei nomi proposti per la tua LLC è disponibile. Proponi 3 nuovi nomi così possiamo verificarne la disponibilità.`,
      options: {
        prompt: 'Please propose 3 new LLC names',
        placeholder: 'NameOne LLC, NameTwo LLC, NameThree LLC',
        required: true,
        name_check: { kind: 'new_names' },
      },
      created_by: params.actor,
    })
    if (!created.ok) return { ok: false, error: created.error }
    return { ok: true, name_checks: checks }
  }

  const entry = checks[params.nameIndex]
  if (!entry) return { ok: false, error: 'Name not found at that index.' }

  // The action must be valid for THIS name's current status (the panel only
  // offers valid ones, but a stale tab or a hand-made request must not be able
  // to, e.g., send an unchecked name to the client or re-mark a refused name
  // "filed" — that also unlocks the filed-name advance gate).
  const startProblem = nameActionProblem(params.action as GuardedNameAction, entry.status)
  if (startProblem) return { ok: false, error: startProblem }
  // Actions that message the client or move the stage never run on a finished case
  // (the stage revert would otherwise flip a completed case back to active).
  if ((params.action === 'send_to_client' || params.action === 'mark_sos_rejected') && isClosedCase(row)) {
    return { ok: false, error: 'This case is already finished — nothing can be sent to the client or reopened from here.' }
  }

  const now = new Date().toISOString()
  const simple = SIMPLE_STATUS[params.action]
  let savedAlready = false

  if (simple) {
    entry.status = simple
    entry.updated_at = now
  } else if (params.action === 'send_to_client') {
    const state = await resolveState(row)
    // Hero title = the LLC name (append "LLC" if not already in the name).
    const displayName = /llc\b/i.test(entry.name) ? entry.name : `${entry.name} LLC`
    // 1. RESERVE the name first (guarded save: status → sent_to_client). If the save
    // conflicts (someone else just acted) nothing has been sent to the client yet.
    // The old order created the client's card, chat note and bell BEFORE this save,
    // so a conflict left an orphan card on the client's portal and a retry created a second one.
    const previousStatus = entry.status
    entry.status = 'sent_to_client'
    entry.updated_at = now
    const reserved = await writeNameChecks(params.sdId, checks, expectedUpdatedAt)
    if (!reserved.ok) return { ok: false, error: reserved.error }
    const created = await createDecisionRequest({
      service_delivery_id: params.sdId,
      request_type: 'approval',
      title: displayName,
      message: `We checked your first choice and this name is currently available in ${state}.\n\nWe'd like to proceed with filing this name with the Secretary of State.\n\nPlease note: the final approval is up to the Secretary of State. If they reject this name, we'll try your other choices or you can propose new ones.\n\nDo you approve filing with this name?`,
      message_it: `Abbiamo verificato la tua prima scelta e questo nome è attualmente disponibile in ${state}.\n\nVorremmo procedere con la registrazione di questo nome presso il Secretary of State.\n\nNota bene: l'approvazione finale spetta al Secretary of State. Se il nome venisse rifiutato, proveremo con le altre opzioni oppure potrai proporne di nuove.\n\nApprovi la registrazione con questo nome?`,
      options: {
        approve_label: 'Yes, proceed',
        reject_label: 'No, use a different name',
        approve_label_it: 'Sì, procedi',
        reject_label_it: 'No, usa un altro nome',
        name_check: { kind: 'approval', name_index: params.nameIndex, name: entry.name },
      },
      created_by: params.actor,
    })
    if (!created.ok) {
      // 2a. The card could not be created: undo the reservation (guarded by the
      // version we just wrote) so the name never sits at "waiting for the client"
      // with no card behind it. Best effort — reported if it cannot be undone.
      entry.status = previousStatus
      entry.updated_at = new Date().toISOString()
      const undone = await writeNameChecks(params.sdId, checks, reserved.updatedAt)
      if (!undone.ok) {
        try {
          const { reportSystemError } = await import('@/lib/system-errors')
          await reportSystemError({
            source: 'server',
            route: 'lib/operations/formation-name-checks.ts:send_to_client',
            message: `A name was reserved as "waiting for the client" but the client request could not be created and the reservation could not be undone (SD ${params.sdId}).`,
            context: { service_delivery_id: params.sdId, name: entry.name },
          })
        } catch {
          /* best-effort */
        }
      }
      return { ok: false, error: created.error }
    }
    // 2b. Link the card to the name (the client's answer is matched by this id; the
    // name's position is only the fallback). Best effort and version-guarded: if the
    // list changed in between (the client already answered) the link is skipped.
    entry.decision_request_id = created.id ?? null
    await writeNameChecks(params.sdId, checks, reserved.updatedAt)
    savedAlready = true
    // A candidate just went back in front of the client for approval — any
    // earlier "none of your names work, propose new ones" ask for this SD is
    // now stale. Cancel it in the SAME step the replacement is created, so
    // the client is never shown both at once, and (unlike gating this on the
    // earlier mark_available step) never shown neither in between.
    await cancelPendingNewNamesRequests(params.sdId)
    await sendNameProposalChatMessage(row, displayName, state, params.actorId ?? null)
  } else if (params.action === 'mark_sos_rejected') {
    // Only a name the client accepted or staff filed can be "refused by the
    // state" (enforced above by nameActionProblem). A name still waiting on the
    // client could be answered later and would flip back to accepted; an
    // unchecked one hasn't been tried.
    entry.status = 'rejected_by_sos'
    entry.updated_at = now
    // Record the refusal FIRST (guarded), then talk to the client — if the save
    // fails nothing was sent, and if the client message fails the refusal is
    // already on record and "Request New Names" still works.
    const saved = await writeNameChecks(params.sdId, checks, expectedUpdatedAt)
    if (!saved.ok) return { ok: false, error: saved.error }
    savedAlready = true
    // Only ask the client for a fresh set once every candidate is actually
    // dead — a rejected filing with an untried sibling still sitting at
    // 'pending' (the normal in-between state; SOS checks happen one name at a
    // time) must send staff back to that sibling first, not the client.
    if (allNamesDead(checks)) {
      await cancelPendingNewNamesRequests(params.sdId)
      const created = await createDecisionRequest({
        service_delivery_id: params.sdId,
        request_type: 'text_input',
        title: 'New LLC Names Needed',
        message: `Unfortunately "${entry.name}" was rejected by the Secretary of State. Please propose 3 new LLC names so we can check their availability.`,
        message_it: `Purtroppo "${entry.name}" è stato rifiutato dal Secretary of State. Proponi 3 nuovi nomi per la tua LLC così possiamo verificarne la disponibilità.`,
        options: {
          prompt: 'Please propose 3 new LLC names',
          placeholder: 'NameOne LLC, NameTwo LLC, NameThree LLC',
          required: true,
          name_check: { kind: 'new_names' },
        },
        created_by: params.actor,
      })
      if (!created.ok) return { ok: false, error: `The refusal was recorded, but the request to the client could not be created: ${created.error}. Use "Request New Names from Client".` }
    }
  } else if (params.action === 'withdraw') {
    // Take the name back from the client: status first (guarded), then retract the
    // open approval request — so a late answer to the card can no longer flip the
    // name (applyNameDecisionResponse ignores an answer for a name that is no
    // longer waiting, and a cancelled request refuses the answer outright).
    const requestId = entry.decision_request_id ?? null
    entry.status = 'available'
    entry.decision_request_id = null
    entry.updated_at = now
    const saved = await writeNameChecks(params.sdId, checks, expectedUpdatedAt)
    if (!saved.ok) return { ok: false, error: saved.error }
    savedAlready = true
    if (requestId) await cancelDecisionRequestById(requestId, params.sdId)
  } else {
    return { ok: false, error: `Unknown action: ${params.action}` }
  }

  if (!savedAlready) {
    const saved = await writeNameChecks(params.sdId, checks, expectedUpdatedAt)
    if (!saved.ok) return { ok: false, error: saved.error }
  }

  // After an SOS rejection, revert the SD to "Wizard Submitted" so the name
  // panel becomes actionable again for the client's resubmitted names (at
  // "Filed with State" the panel is read-only). Use the canonical advance path
  // so the formation_progress task's sd_stage stays synced; skip_tasks +
  // skip_notify so we neither re-spawn stage tasks nor send the client a
  // confusing "moved to Wizard Submitted" notification. Best-effort — the name
  // is already rejected and the new-names request already created.
  // Skipped when the case is already there: re-"advancing" to the same step
  // would reset its timers and add a bogus history entry.
  if (params.action === 'mark_sos_rejected' && fresh.stage !== 'Wizard Submitted') {
    try {
      const { advanceServiceDelivery } = await import('@/lib/service-delivery')
      const adv = await advanceServiceDelivery({
        delivery_id: params.sdId,
        target_stage: 'Wizard Submitted',
        skip_tasks: true,
        skip_notify: true,
        actor: 'name-sos-rejected',
        notes: `SOS rejected "${entry.name}" — reverted to Wizard Submitted for name re-selection`,
      })
      if (adv && adv.success === false) {
        console.error(`mark_sos_rejected: stage revert refused for SD ${params.sdId}:`, adv.error)
      }
    } catch {
      /* best-effort: stage revert is non-critical to the rejection itself */
    }
  }

  return { ok: true, name_checks: checks }
}

/**
 * Apply a client's decision response back onto name_checks. Called from
 * respondToDecisionRequest ONLY when the request carries an `options.name_check`
 * marker (so the decisions system stays type-agnostic).
 */
export async function applyNameDecisionResponse(
  req: DecisionRequest,
  status: string,
  response: Record<string, unknown>,
): Promise<void> {
  const marker = (req.options as { name_check?: { kind?: string; name_index?: number; split?: string; max?: number } } | null)?.name_check
  if (!marker || !req.service_delivery_id) return

  // Read-modify-write with a version guard: if staff (or another answer) changed
  // the list between our read and our save, re-read and redo, so neither side's
  // change is silently lost. Three tries, then it is reported, not swallowed.
  let rejectedName: string | null = null
  let rejectionNote: string | null = null
  let suggestedNewName: string | null = null
  let saved = false
  let ignored = false

  for (let attempt = 0; attempt < 3 && !saved && !ignored; attempt++) {
    // ONE read: the list and the stamp the guarded save compares against.
    const loaded = await loadWithChecks(req.service_delivery_id)
    if (!loaded) {
      ignored = true
      break
    }
    let checks = loaded.checks
    const fresh = loaded.row
    const now = new Date().toISOString()
    rejectedName = null
    rejectionNote = null
    suggestedNewName = null

    if (marker.kind === 'approval') {
      // Prefer matching by the stored decision_request_id; fall back to name_index.
      let idx = checks.findIndex((c) => c.decision_request_id === req.id)
      if (idx < 0 && typeof marker.name_index === 'number') idx = marker.name_index
      if (idx < 0 || !checks[idx]) {
        ignored = true
        break
      }
      // A late answer for a name staff already moved on from (e.g. recorded as
      // refused by the state) must not bring that name back to life.
      if (checks[idx].status !== 'sent_to_client') {
        ignored = true
        break
      }
      const approved = status === 'approved'
      checks[idx].status = approved ? 'accepted' : 'rejected_by_client'
      checks[idx].updated_at = now
      if (!approved) {
        // Store the client's note ON the name so the workspace row can show it.
        const note = typeof response.note === 'string' && response.note.trim() ? response.note.trim() : null
        checks[idx].note = note
        rejectedName = checks[idx].name
        rejectionNote = note
        // The client may suggest a replacement name → add it as a new pending
        // candidate so it appears immediately in the workspace name panel.
        // Dedupe (same-name key: case, punctuation, trailing LLC ignored) so we
        // don't double-add an existing name.
        const suggested = typeof response.suggested_name === 'string' ? response.suggested_name.trim() : ''
        const suggestedKey = nameDedupeKey(suggested)
        if (suggestedKey && !checks.some((c) => nameDedupeKey(c.name) === suggestedKey)) {
          checks.push({ name: suggested, source: 'client_suggestion', status: 'pending', updated_at: now })
          suggestedNewName = suggested
        }
      }
    } else if (marker.kind === 'new_names') {
      // `split: 'lines'` (set by asks for ONE or a few full names) keeps a comma
      // inside a name ("Acme Holdings, LLC"); the default splits on commas as it always did.
      const proposed = parseProposedNames(response.text, {
        separators: marker.split === 'lines' ? 'lines' : 'all',
        max: typeof marker.max === 'number' ? marker.max : undefined,
      })
      // A name already on the list — dead ones included — does not come back.
      checks = addClientNames(checks, proposed, now).checks
    }

    const w = await writeNameChecks(req.service_delivery_id, checks, fresh?.updated_at ?? null)
    if (w.ok) {
      saved = true
    } else if (!w.conflict) {
      break
    }
  }

  if (!saved) {
    if (!ignored) {
      try {
        const { reportSystemError } = await import('@/lib/system-errors')
        await reportSystemError({
          source: 'server',
          route: 'lib/operations/formation-name-checks.ts:applyNameDecisionResponse',
          message: `Could not save a client's answer onto the name list for SD ${req.service_delivery_id} (request ${req.id}).`,
          context: { service_delivery_id: req.service_delivery_id, decision_request_id: req.id },
        })
      } catch {
        /* best-effort */
      }
    }
    return
  }

  // Post an SD-scoped flow-chat note when the client rejects a name, so staff see
  // the rejection (and the client's reason) in the workspace chat — the generic
  // What's New note isn't service-delivery-scoped. System sender
  // (portal_messages.sender_id is NOT NULL). Best-effort: the rejection status +
  // note are already saved.
  if (rejectedName) {
    try {
      const row = await loadSd(req.service_delivery_id)
      const topic = row ? buildFlowTopic(row.service_type, deriveFlowYear(row)) || null : null
      const base = rejectionNote
        ? `Client rejected "${rejectedName}" — "${rejectionNote}"`
        : `Client rejected "${rejectedName}".`
      const message = suggestedNewName
        ? `${base} They suggested "${suggestedNewName}" instead — added to the name list.`
        : base
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service_delivery_id not in generated types
      await (supabaseAdmin as any).from('portal_messages').insert({
        account_id: req.account_id ?? null,
        contact_id: req.contact_id ?? null,
        service_delivery_id: req.service_delivery_id,
        topic,
        sender_type: 'system',
        sender_id: '00000000-0000-0000-0000-000000000000',
        message,
      })
    } catch {
      /* best-effort */
    }
  }
}
