/**
 * Formation Name Command Center — server operations over
 * `service_deliveries.name_checks` (JSONB). Backs POST /api/flows/[id]/name-check
 * and the decision-response hook. The column is new (not in generated types) so
 * reads/writes use an untyped accessor.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { isItalian } from '@/lib/locale'
import {
  initNameChecksFromWizard,
  parseProposedNames,
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

interface SdRow {
  id: string
  contact_id: string | null
  account_id: string | null
  name_checks: NameCheck[] | null
  service_type: string | null
  due_date: string | null
  stage_entered_at: string | null
  created_at: string | null
}

async function loadSd(sdId: string): Promise<SdRow | null> {
  // NOTE: state_of_formation lives on `accounts`, NOT service_deliveries —
  // selecting it here errors the whole query (and silently empties name_checks).
  // service_type + the date columns feed the flow-chat topic/year (send_to_client).
  const { data } = await sd()
    .select('id, contact_id, account_id, name_checks, service_type, due_date, stage_entered_at, created_at')
    .eq('id', sdId)
    .maybeSingle()
  return (data as SdRow | null) ?? null
}

async function writeNameChecks(sdId: string, checks: NameCheck[]): Promise<void> {
  await sd().update({ name_checks: checks, updated_at: new Date().toISOString() }).eq('id', sdId)
}

/**
 * Resolve the formation state of an in-flight SD: the account's state, else the
 * latest formation wizard's state, else "New Mexico".
 */
async function resolveState(row: SdRow): Promise<string> {
  if (row.account_id) {
    const { data: acct } = await supabaseAdmin
      .from('accounts')
      .select('state_of_formation')
      .eq('id', row.account_id)
      .maybeSingle()
    if (acct?.state_of_formation) return acct.state_of_formation as string
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
    const d = (wp?.data ?? null) as Record<string, unknown> | null
    const s = d?.state_of_formation ?? d?.state_of_incorporation
    if (typeof s === 'string' && s.trim()) return s.trim()
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
  const row = await loadSd(sdId)
  if (!row) return []
  if (Array.isArray(row.name_checks) && row.name_checks.length > 0) return row.name_checks

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
    checks = initNameChecksFromWizard((wp?.data ?? null) as Record<string, unknown> | null)
  }
  if (checks.length > 0) await writeNameChecks(sdId, checks)
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

/**
 * Supersede any still-pending "new names" (text_input) request for this SD before
 * creating a fresh one, so the client never sees TWO name-request windows at once
 * (e.g. an unanswered "all names unavailable" request plus a later SOS-rejection
 * request). Only the latest request stays pending.
 */
async function cancelPendingNewNamesRequests(sdId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client_decision_requests not in generated types
  await (supabaseAdmin as any)
    .from('client_decision_requests')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('service_delivery_id', sdId)
    .eq('status', 'pending')
    .eq('request_type', 'text_input')
}

/** Apply a staff name action; creates decision requests for send/sos-reject. */
export async function handleNameAction(params: {
  sdId: string
  action: NameAction
  nameIndex: number
  actor: string
  /** Auth user UUID — used as portal_messages.sender_id for the flow chat note
   *  (that column is NOT NULL, so without it the heads-up message is dropped). */
  actorId?: string | null
}): Promise<NameActionResult> {
  const row = await loadSd(params.sdId)
  if (!row) return { ok: false, error: 'Service delivery not found.' }

  const checks = await getOrInitNameChecks(params.sdId)

  // request_new_names is not tied to a specific candidate — it asks the client
  // for a fresh set when none of the current names are viable. Handle before the
  // per-name entry lookup (no nameIndex required).
  if (params.action === 'request_new_names') {
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

  const now = new Date().toISOString()
  const simple = SIMPLE_STATUS[params.action]

  if (simple) {
    entry.status = simple
    entry.updated_at = now
  } else if (params.action === 'send_to_client') {
    const state = await resolveState(row)
    // Hero title = the LLC name (append "LLC" if not already in the name).
    const displayName = /llc\b/i.test(entry.name) ? entry.name : `${entry.name} LLC`
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
    if (!created.ok) return { ok: false, error: created.error }
    entry.status = 'sent_to_client'
    entry.decision_request_id = created.id ?? null
    entry.updated_at = now
    await sendNameProposalChatMessage(row, displayName, state, params.actorId ?? null)
  } else if (params.action === 'mark_sos_rejected') {
    entry.status = 'rejected_by_sos'
    entry.updated_at = now
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
    if (!created.ok) return { ok: false, error: created.error }
  } else {
    return { ok: false, error: `Unknown action: ${params.action}` }
  }

  await writeNameChecks(params.sdId, checks)

  // After an SOS rejection, revert the SD to "Wizard Submitted" so the name
  // panel becomes actionable again for the client's resubmitted names (at
  // "Filed with State" the panel is read-only). Use the canonical advance path
  // so the formation_progress task's sd_stage stays synced; skip_tasks +
  // skip_notify so we neither re-spawn stage tasks nor send the client a
  // confusing "moved to Wizard Submitted" notification. Best-effort — the name
  // is already rejected and the new-names request already created.
  if (params.action === 'mark_sos_rejected') {
    try {
      const { advanceServiceDelivery } = await import('@/lib/service-delivery')
      await advanceServiceDelivery({
        delivery_id: params.sdId,
        target_stage: 'Wizard Submitted',
        skip_tasks: true,
        skip_notify: true,
        actor: 'name-sos-rejected',
        notes: `SOS rejected "${entry.name}" — reverted to Wizard Submitted for name re-selection`,
      })
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
  const marker = (req.options as { name_check?: { kind?: string; name_index?: number } } | null)?.name_check
  if (!marker || !req.service_delivery_id) return

  const checks = await getOrInitNameChecks(req.service_delivery_id)
  const now = new Date().toISOString()

  let rejectedName: string | null = null
  let rejectionNote: string | null = null
  let suggestedNewName: string | null = null

  if (marker.kind === 'approval') {
    // Prefer matching by the stored decision_request_id; fall back to name_index.
    let idx = checks.findIndex((c) => c.decision_request_id === req.id)
    if (idx < 0 && typeof marker.name_index === 'number') idx = marker.name_index
    if (idx >= 0 && checks[idx]) {
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
        // Dedupe (case-insensitive) so we don't double-add an existing name.
        const suggested = typeof response.suggested_name === 'string' ? response.suggested_name.trim() : ''
        if (suggested && !checks.some((c) => c.name.toLowerCase() === suggested.toLowerCase())) {
          checks.push({ name: suggested, source: 'client_suggestion', status: 'pending', updated_at: now })
          suggestedNewName = suggested
        }
      }
    }
  } else if (marker.kind === 'new_names') {
    for (const name of parseProposedNames(response.text)) {
      checks.push({ name, source: 'client_resubmit', status: 'pending', updated_at: now })
    }
  }

  await writeNameChecks(req.service_delivery_id, checks)

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
