/**
 * Client Decision Requests — shared types + pure validation.
 *
 * Three generic request types only (per docs/specs/CLIENT-DECISION-REQUESTS.md):
 *   - approval   → yes/no              response { decision, note? }
 *   - choice     → pick one option     response { selected, note? }
 *   - text_input → free text           response { text }
 *
 * Anything more specific (an LLC name proposal, a document sign-off) is a
 * configured instance of one of these — the business context lives in
 * title/message/options, never in a new type.
 *
 * This module is PURE (no DB, no I/O) so the response validation is unit-tested
 * and reused by the respond API route.
 */

export const DECISION_REQUEST_TYPES = ['approval', 'choice', 'text_input'] as const
export type DecisionRequestType = (typeof DECISION_REQUEST_TYPES)[number]

export const DECISION_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'responded',
  'expired',
  'cancelled',
] as const
export type DecisionStatus = (typeof DECISION_STATUSES)[number]

/** Terminal status produced by a client response. */
export type RespondedStatus = Extract<DecisionStatus, 'approved' | 'rejected' | 'responded'>

// ── Options shapes (by type) ────────────────────────────────────────────────

export interface ApprovalOptions {
  approve_label?: string
  reject_label?: string
}
export interface ChoiceOption {
  key: string
  label: string
  description?: string
}
export interface ChoiceOptions {
  choices: ChoiceOption[]
  allow_multiple?: boolean
}
export interface TextInputOptions {
  prompt?: string
  placeholder?: string
  required?: boolean
}

// ── Response shapes (by type) ────────────────────────────────────────────────

export interface ApprovalResponse {
  decision: 'approved' | 'rejected'
  note?: string
}
export interface ChoiceResponse {
  selected: string
  note?: string
}
export interface TextInputResponse {
  text: string
}

/** A full client_decision_requests row (client-safe shape, used by UI + API). */
export interface DecisionRequest {
  id: string
  service_delivery_id: string
  contact_id: string | null
  account_id: string | null
  request_type: DecisionRequestType | string
  title: string
  message: string
  message_it: string | null
  options: Record<string, unknown> | null
  status: DecisionStatus | string
  response: Record<string, unknown> | null
  responded_at: string | null
  responded_by: string | null
  expires_at: string | null
  created_by: string
  created_at: string
  updated_at: string
  stage_at_creation: string | null
  auto_advance_on: string | null
  notify_on_response: boolean
}

export function isDecisionRequestType(v: unknown): v is DecisionRequestType {
  return typeof v === 'string' && (DECISION_REQUEST_TYPES as readonly string[]).includes(v)
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

export interface ValidateResponseResult {
  ok: boolean
  error?: string
  /** Normalized response to persist (only when ok). */
  response?: Record<string, unknown>
  /** The status the request should move to (only when ok). */
  status?: RespondedStatus
}

/**
 * Validate + normalize a client's response against the request type and options.
 * Returns the canonical response to store and the resulting status. Pure.
 */
export function validateDecisionResponse(
  requestType: string,
  rawResponse: unknown,
  options: Record<string, unknown> | null | undefined,
): ValidateResponseResult {
  if (!isDecisionRequestType(requestType)) {
    return { ok: false, error: `Unknown request type: ${requestType}` }
  }
  if (!rawResponse || typeof rawResponse !== 'object') {
    return { ok: false, error: 'Response must be an object.' }
  }
  const r = rawResponse as Record<string, unknown>
  const note = str(r.note) ?? undefined

  if (requestType === 'approval') {
    const decision = r.decision
    if (decision !== 'approved' && decision !== 'rejected') {
      return { ok: false, error: 'Response.decision must be "approved" or "rejected".' }
    }
    // On a rejection the client may suggest a name to use instead — preserve it
    // (the formation name flow turns it into a new pending candidate).
    const suggestedName = str(r.suggested_name) ?? undefined
    return {
      ok: true,
      response: {
        decision,
        ...(note ? { note } : {}),
        ...(decision === 'rejected' && suggestedName ? { suggested_name: suggestedName } : {}),
      },
      status: decision,
    }
  }

  if (requestType === 'choice') {
    const selected = str(r.selected)
    if (!selected) {
      return { ok: false, error: 'Response.selected is required.' }
    }
    const rawChoices = options?.choices
    const choices: ChoiceOption[] = Array.isArray(rawChoices) ? (rawChoices as ChoiceOption[]) : []
    const validKeys = choices.map((c) => c?.key).filter((k): k is string => typeof k === 'string')
    if (validKeys.length > 0 && !validKeys.includes(selected)) {
      return { ok: false, error: `Response.selected "${selected}" is not one of the offered choices.` }
    }
    return {
      ok: true,
      response: { selected, ...(note ? { note } : {}) },
      status: 'responded',
    }
  }

  // text_input
  const text = str(r.text)
  if (!text) {
    return { ok: false, error: 'Response.text is required.' }
  }
  return { ok: true, response: { text }, status: 'responded' }
}

/**
 * Validate the OPTIONS a staff member supplies at creation time. Lightweight —
 * approval/text_input accept anything (labels/prompt are optional); choice
 * requires a non-empty list of choices each with a key + label. Pure.
 */
export function validateDecisionOptions(
  requestType: string,
  options: unknown,
): { ok: boolean; error?: string } {
  if (!isDecisionRequestType(requestType)) {
    return { ok: false, error: `Unknown request type: ${requestType}` }
  }
  if (requestType === 'choice') {
    const choices = (options as ChoiceOptions | null | undefined)?.choices
    if (!Array.isArray(choices) || choices.length === 0) {
      return { ok: false, error: 'A choice request needs a non-empty "choices" array.' }
    }
    for (const c of choices) {
      if (!c || typeof c !== 'object' || !str((c as ChoiceOption).key) || !str((c as ChoiceOption).label)) {
        return { ok: false, error: 'Each choice needs a non-empty "key" and "label".' }
      }
    }
  }
  return { ok: true }
}
