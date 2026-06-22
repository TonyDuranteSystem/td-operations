/**
 * Client Decision Requests — operations layer (create + respond).
 *
 * Shared by the API routes. Keeps the business logic (validation, notifications,
 * action_log, optional auto-advance) in one place. The table is new and not yet
 * in the generated DB types, so reads/writes go through an untyped accessor.
 *
 * See docs/specs/CLIENT-DECISION-REQUESTS.md.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import type { Json } from '@/lib/database.types'
import {
  validateDecisionResponse,
  validateDecisionOptions,
  isDecisionRequestType,
  type DecisionRequest,
} from '@/lib/decisions'

/** Row shape — re-exported alias of the client-safe DecisionRequest type. */
export type DecisionRequestRow = DecisionRequest

// client_decision_requests is new — not in the generated DB types yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cdr = () => (supabaseAdmin as any).from('client_decision_requests')

/** Fetch one decision request by id (untyped table). */
export async function getDecisionRequest(id: string): Promise<DecisionRequestRow | null> {
  const { data } = (await cdr().select('*').eq('id', id).maybeSingle()) as { data: DecisionRequestRow | null }
  return data ?? null
}

/** All decision requests for a service delivery, newest first (workspace history). */
export async function listDecisionRequestsForSd(serviceDeliveryId: string): Promise<DecisionRequestRow[]> {
  const { data } = (await cdr()
    .select('*')
    .eq('service_delivery_id', serviceDeliveryId)
    .order('created_at', { ascending: false })) as { data: DecisionRequestRow[] | null }
  return data ?? []
}

/** A contact's pending decision requests across all flows (portal action items). */
export async function listPendingDecisionsForContact(contactId: string): Promise<DecisionRequestRow[]> {
  const { data } = (await cdr()
    .select('*')
    .eq('contact_id', contactId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })) as { data: DecisionRequestRow[] | null }
  return data ?? []
}

export interface CreateDecisionParams {
  service_delivery_id: string
  /** Defaults to the SD's contact_id when omitted. */
  contact_id?: string | null
  account_id?: string | null
  request_type: string
  title: string
  message: string
  message_it?: string | null
  options?: Record<string, unknown>
  auto_advance_on?: string | null
  expires_at?: string | null
  notify_on_response?: boolean
  created_by: string
}

export interface CreateDecisionResult {
  ok: boolean
  id?: string
  error?: string
}

/** Create a decision request scoped to a service delivery + notify the client. */
export async function createDecisionRequest(params: CreateDecisionParams): Promise<CreateDecisionResult> {
  if (!isDecisionRequestType(params.request_type)) {
    return { ok: false, error: `Unknown request type: ${params.request_type}` }
  }
  if (!params.service_delivery_id) {
    return { ok: false, error: 'service_delivery_id is required.' }
  }
  if (!params.title?.trim() || !params.message?.trim()) {
    return { ok: false, error: 'Title and message are required.' }
  }
  const optCheck = validateDecisionOptions(params.request_type, params.options ?? {})
  if (!optCheck.ok) return { ok: false, error: optCheck.error }

  // Resolve the SD's current stage + account + contact for stamping.
  const { data: sd } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, stage, account_id, contact_id')
    .eq('id', params.service_delivery_id)
    .maybeSingle()
  if (!sd) return { ok: false, error: 'Service delivery not found.' }

  const account_id = params.account_id ?? (sd.account_id as string | null) ?? null
  const contact_id = params.contact_id ?? (sd.contact_id as string | null) ?? null
  if (!contact_id) {
    return { ok: false, error: 'No client contact to send this request to (the service delivery has no contact).' }
  }

  const { data, error } = await cdr()
    .insert({
      service_delivery_id: params.service_delivery_id,
      contact_id,
      account_id,
      request_type: params.request_type,
      title: params.title.trim(),
      message: params.message.trim(),
      message_it: params.message_it?.trim() || null,
      options: params.options ?? {},
      status: 'pending',
      auto_advance_on: params.auto_advance_on || null,
      expires_at: params.expires_at || null,
      notify_on_response: params.notify_on_response ?? true,
      created_by: params.created_by,
      stage_at_creation: (sd.stage as string | null) ?? null,
    })
    .select('id')
    .single()

  if (error || !data) return { ok: false, error: error?.message ?? 'Insert failed.' }

  // Notify the client in the portal (non-fatal).
  try {
    const { createPortalNotification } = await import('@/lib/portal/notifications')
    await createPortalNotification({
      account_id: account_id ?? undefined,
      contact_id,
      type: 'decision',
      title: params.title.trim(),
      body: 'You have a new request from Tony Durante LLC — please review and respond.',
      link: `/portal/flows/${params.service_delivery_id}`,
    })
  } catch {
    // non-critical — the request still exists and shows in the portal
  }

  return { ok: true, id: data.id as string }
}

export interface RespondDecisionParams {
  id: string
  rawResponse: unknown
  /** Portal user id (auth.users) that responded. */
  respondedBy?: string | null
  actor?: string
}

export interface RespondDecisionResult {
  ok: boolean
  status?: string
  error?: string
  auto_advanced?: boolean
}

/** Short human summary of a response, for the staff What's New note. */
function summarizeResponse(req: DecisionRequestRow, response: Record<string, unknown>): string {
  if (req.request_type === 'approval') {
    const label = response.decision === 'approved' ? 'Approved' : 'Rejected'
    const note = typeof response.note === 'string' && response.note.trim() ? response.note.trim() : null
    return note ? `${label} — "${note}"` : label
  }
  if (req.request_type === 'choice') {
    const rawChoices = req.options?.choices
    const choices = Array.isArray(rawChoices) ? (rawChoices as { key: string; label: string }[]) : []
    const picked = choices.find((c) => c.key === response.selected)
    return `Selected: ${picked?.label ?? String(response.selected ?? '')}`
  }
  const text = typeof response.text === 'string' ? response.text : ''
  return `Provided: ${text.length > 80 ? text.slice(0, 80) + '…' : text}`
}

/**
 * Record a client's response to a decision request. Validates against the type,
 * guards against double-answer (TOCTOU on status='pending'), logs to action_log,
 * emits a staff What's New event, and optionally auto-advances the SD when an
 * `auto_advance_on` stage is set and the client approved.
 */
export async function respondToDecisionRequest(params: RespondDecisionParams): Promise<RespondDecisionResult> {
  const { data: req } = (await cdr().select('*').eq('id', params.id).maybeSingle()) as { data: DecisionRequestRow | null }
  if (!req) return { ok: false, error: 'Decision request not found.' }
  if (req.status !== 'pending') {
    return { ok: false, error: 'This request has already been answered or is no longer active.' }
  }
  if (req.expires_at && new Date(req.expires_at).getTime() < Date.now()) {
    await cdr().update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', params.id).eq('status', 'pending')
    return { ok: false, error: 'This request has expired.' }
  }

  const v = validateDecisionResponse(req.request_type, params.rawResponse, req.options ?? {})
  if (!v.ok || !v.status || !v.response) return { ok: false, error: v.error ?? 'Invalid response.' }

  // TOCTOU guard: only the first responder (still pending) wins.
  const { data: updated } = await cdr()
    .update({
      status: v.status,
      response: v.response,
      responded_at: new Date().toISOString(),
      responded_by: params.respondedBy ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()
  if (!updated) return { ok: false, error: 'This request has already been answered.' }

  const summary = summarizeResponse(req, v.response)

  // Audit trail.
  await supabaseAdmin.from('action_log').insert({
    actor: params.actor ?? 'portal-client',
    action_type: 'decision_response',
    table_name: 'client_decision_requests',
    record_id: req.id,
    account_id: req.account_id ?? undefined,
    summary: `Client response to "${req.title}": ${summary}`,
    details: {
      request_type: req.request_type,
      service_delivery_id: req.service_delivery_id,
      status: v.status,
      response: v.response as unknown as Json,
    },
  })

  // Staff What's New note (non-fatal).
  if (req.notify_on_response !== false) {
    try {
      const { emitDecisionRespondedEvent } = await import('@/lib/portal/chat-events')
      await emitDecisionRespondedEvent({
        request_id: req.id,
        contact_id: req.contact_id,
        account_id: req.account_id,
        title: req.title,
        summary,
      })
    } catch {
      // non-critical
    }
  }

  // Formation name flow: when the request carries a name_check marker, reflect
  // the response onto service_deliveries.name_checks. Gated by the marker so the
  // decisions system itself stays type-agnostic (non-fatal).
  if ((req.options as { name_check?: unknown } | null)?.name_check) {
    try {
      const { applyNameDecisionResponse } = await import('@/lib/operations/formation-name-checks')
      await applyNameDecisionResponse(req, v.status, v.response)
    } catch {
      // non-critical — staff can correct the name status from the workspace
    }
  }

  // Optional auto-advance on approval.
  let auto_advanced = false
  if (req.auto_advance_on && v.status === 'approved' && req.service_delivery_id) {
    try {
      const { advanceServiceDelivery } = await import('@/lib/service-delivery')
      const adv = await advanceServiceDelivery({
        delivery_id: req.service_delivery_id,
        target_stage: req.auto_advance_on,
        actor: 'decision-auto-advance',
        notes: `Auto-advanced on client approval of "${req.title}"`,
      })
      auto_advanced = adv.success
    } catch {
      // non-critical — staff can advance manually
    }
  }

  return { ok: true, status: v.status, auto_advanced }
}
