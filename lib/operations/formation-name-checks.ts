/**
 * Formation Name Command Center — server operations over
 * `service_deliveries.name_checks` (JSONB). Backs POST /api/flows/[id]/name-check
 * and the decision-response hook. The column is new (not in generated types) so
 * reads/writes use an untyped accessor.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  initNameChecksFromWizard,
  parseProposedNames,
  type NameCheck,
  type NameCheckStatus,
} from '@/lib/flows/name-checks'
import { createDecisionRequest } from '@/lib/operations/decision-request'
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

interface SdRow {
  id: string
  contact_id: string | null
  account_id: string | null
  state_of_formation: string | null
  name_checks: NameCheck[] | null
}

async function loadSd(sdId: string): Promise<SdRow | null> {
  const { data } = await sd()
    .select('id, contact_id, account_id, state_of_formation, name_checks')
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
  if (row.state_of_formation) return row.state_of_formation
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

/** Apply a staff name action; creates decision requests for send/sos-reject. */
export async function handleNameAction(params: {
  sdId: string
  action: NameAction
  nameIndex: number
  actor: string
}): Promise<NameActionResult> {
  const row = await loadSd(params.sdId)
  if (!row) return { ok: false, error: 'Service delivery not found.' }

  const checks = await getOrInitNameChecks(params.sdId)
  const entry = checks[params.nameIndex]
  if (!entry) return { ok: false, error: 'Name not found at that index.' }

  const now = new Date().toISOString()
  const simple = SIMPLE_STATUS[params.action]

  if (simple) {
    entry.status = simple
    entry.updated_at = now
  } else if (params.action === 'send_to_client') {
    const state = await resolveState(row)
    const created = await createDecisionRequest({
      service_delivery_id: params.sdId,
      request_type: 'approval',
      title: 'LLC Name Approval',
      message: `${entry.name} is available in ${state}. Do you accept this name for your LLC?`,
      message_it: `${entry.name} è disponibile in ${state}. Accetti questo nome per la tua LLC?`,
      options: {
        approve_label: 'Yes, I accept',
        reject_label: 'No, try another',
        name_check: { kind: 'approval', name_index: params.nameIndex, name: entry.name },
      },
      created_by: params.actor,
    })
    if (!created.ok) return { ok: false, error: created.error }
    entry.status = 'sent_to_client'
    entry.decision_request_id = created.id ?? null
    entry.updated_at = now
  } else if (params.action === 'mark_sos_rejected') {
    entry.status = 'rejected_by_sos'
    entry.updated_at = now
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

  if (marker.kind === 'approval') {
    // Prefer matching by the stored decision_request_id; fall back to name_index.
    let idx = checks.findIndex((c) => c.decision_request_id === req.id)
    if (idx < 0 && typeof marker.name_index === 'number') idx = marker.name_index
    if (idx >= 0 && checks[idx]) {
      checks[idx].status = status === 'approved' ? 'accepted' : 'rejected_by_client'
      checks[idx].updated_at = now
    }
  } else if (marker.kind === 'new_names') {
    for (const name of parseProposedNames(response.text)) {
      checks.push({ name, source: 'client_resubmit', status: 'pending', updated_at: now })
    }
  }

  await writeNameChecks(req.service_delivery_id, checks)
}
