/**
 * AI-agent enum normalization.
 *
 * The AI-agent tools (lib/ai-agent/tools.ts) write to, and filter on, several
 * columns backed by real Postgres ENUM types. An invalid value on a write throws
 * `22P02 invalid_input_value_for_enum`; an invalid value on a search filter
 * silently returns zero rows. Models (and humans) routinely send the "wrong"
 * casing or a synonym ('medium' for 'Normal', 'todo' for 'To Do').
 *
 * This module is the single source of truth that maps flexible input → the exact
 * canonical DB value. The principle is FLEXIBLE, NOT HARDCODED: accept both
 * casings and common synonyms gracefully, normalize to the canonical value the
 * DB enum actually expects.
 *
 * Canonical values verified against the live DB (sandbox pg_enum, 2026-06-04):
 *   - task_priority, task_status, task_category
 *   - service_status
 *   - conversation_channel
 *   - account_status, payment_status, deal_stage, lead_status, tax_return_status
 *   - deadlines.status (text column, observed distinct values)
 * They are defined by migration DDL applied identically to sandbox + production.
 *
 * Each normalizer returns the canonical value for a recognized input, or `null`
 * for an unrecognized one. Callers decide what to do with `null`:
 *   - write paths: fall back to a safe valid default, or surface a clear error,
 *   - search filters: pass the original through (an exact match that returns
 *     nothing is harmless and preserves prior behavior),
 *   - propose path: leave the original so validateToolParams flags it.
 *
 * DB-free and pure → trivially unit-testable.
 */

// ── Canonical enum values (mirror the DB; keep in sync with the migrations) ──

export const TASK_PRIORITY_VALUES = ["Urgent", "High", "Normal", "Low"] as const
export const TASK_STATUS_VALUES = ["To Do", "In Progress", "Waiting", "Done", "Cancelled"] as const
export const TASK_CATEGORY_VALUES = [
  "Client Response",
  "Document",
  "Filing",
  "Follow-up",
  "Payment",
  "CRM Update",
  "Internal",
  "KYC",
  "Shipping",
  "Notarization",
  "Client Communication",
  "Formation",
] as const
export const SERVICE_STATUS_VALUES = [
  "Not Started",
  "In Progress",
  "Waiting Client",
  "Waiting Third Party",
  "Completed",
  "Cancelled",
] as const
export const CONVERSATION_CHANNEL_VALUES = [
  "WhatsApp",
  "Telegram",
  "Email",
  "Phone",
  "Portal",
  "In-Person",
  "Calendly",
  "Zoom",
] as const
export const ACCOUNT_STATUS_VALUES = [
  "Active",
  "Pending Formation",
  "Delinquent",
  "Suspended",
  "Offboarding",
  "Cancelled",
  "Closed",
] as const
export const PAYMENT_STATUS_VALUES = [
  "Pending",
  "Paid",
  "Overdue",
  "Delinquent",
  "Waived",
  "Refunded",
  "Not Invoiced",
  "Cancelled",
] as const
export const DEAL_STAGE_VALUES = [
  "Initial Consultation",
  "Offer Sent",
  "Negotiation",
  "Agreement Signed",
  "Paid",
  "Closed Won",
  "Closed Lost",
] as const
export const LEAD_STATUS_VALUES = [
  "New",
  "Call Scheduled",
  "Call Done",
  "Offer Sent",
  "Negotiating",
  "Paid",
  "Converted",
  "Lost",
  "Suspended",
] as const
export const TAX_RETURN_STATUS_VALUES = [
  "Payment Pending",
  "Link Sent - Awaiting Data",
  "Data Received",
  "Sent to Accountant",
  // Legacy label — still a valid tax_return_status enum value (renamed to "Sent to
  // Accountant" 2026-06-09, old value not dropped). Kept so normalization accepts it.
  "Sent to India",
  "Extension Filed",
  "TR Completed - Awaiting Signature",
  "TR Filed",
  "Paid - Not Started",
  "Activated - Need Link",
  "Not Invoiced",
  "Extension Requested",
  "2nd Installment Paid",
  "Wizard Available",
  "1st Installment Paid",
] as const
// deadlines.status is a free-text column, but the codebase only ever uses this
// closed set of values. Normalizing them keeps filters case-insensitive.
export const DEADLINE_STATUS_VALUES = [
  "Pending",
  "Completed",
  "Filed",
  "Not Started",
  "Cancelled",
  "Overdue",
] as const

/**
 * Build a case-insensitive normalizer over a canonical value set plus an optional
 * alias map (alias keys are matched case-insensitively too). Returns the exact
 * canonical value or `null`.
 */
function buildNormalizer(
  canonical: readonly string[],
  aliases: Record<string, string> = {},
): (input: unknown) => string | null {
  const byLower = new Map<string, string>()
  for (const v of canonical) byLower.set(v.toLowerCase(), v)
  const aliasByLower = new Map<string, string>()
  for (const [k, v] of Object.entries(aliases)) aliasByLower.set(k.toLowerCase(), v)

  return (input: unknown): string | null => {
    if (typeof input !== "string") return null
    const key = input.trim().toLowerCase()
    if (!key) return null
    return byLower.get(key) ?? aliasByLower.get(key) ?? null
  }
}

// ── Per-field normalizers ──

export const normalizeTaskPriority = buildNormalizer(TASK_PRIORITY_VALUES, {
  medium: "Normal",
  med: "Normal",
  moderate: "Normal",
  critical: "Urgent",
})

export const normalizeTaskStatus = buildNormalizer(TASK_STATUS_VALUES, {
  todo: "To Do",
  "to-do": "To Do",
  open: "To Do",
  "in-progress": "In Progress",
  inprogress: "In Progress",
  doing: "In Progress",
  blocked: "Waiting",
  "on hold": "Waiting",
  "on-hold": "Waiting",
  complete: "Done",
  completed: "Done",
  finished: "Done",
  closed: "Done",
  canceled: "Cancelled",
})

export const normalizeTaskCategory = buildNormalizer(TASK_CATEGORY_VALUES, {
  "follow up": "Follow-up",
  followup: "Follow-up",
  "client comms": "Client Communication",
  communication: "Client Communication",
})

export const normalizeServiceStatus = buildNormalizer(SERVICE_STATUS_VALUES, {
  "not-started": "Not Started",
  notstarted: "Not Started",
  "in-progress": "In Progress",
  inprogress: "In Progress",
  complete: "Completed",
  done: "Completed",
  canceled: "Cancelled",
})

export const normalizeConversationChannel = buildNormalizer(CONVERSATION_CHANNEL_VALUES, {
  "whats app": "WhatsApp",
  wa: "WhatsApp",
  call: "Phone",
  "in person": "In-Person",
  meeting: "Zoom",
})

export const normalizeAccountStatus = buildNormalizer(ACCOUNT_STATUS_VALUES, {
  pending: "Pending Formation",
  "pending formation": "Pending Formation",
})

export const normalizePaymentStatus = buildNormalizer(PAYMENT_STATUS_VALUES, {
  unpaid: "Pending",
  "not invoiced": "Not Invoiced",
})

export const normalizeDealStage = buildNormalizer(DEAL_STAGE_VALUES, {
  won: "Closed Won",
  "closed-won": "Closed Won",
  lost: "Closed Lost",
  "closed-lost": "Closed Lost",
})

export const normalizeLeadStatus = buildNormalizer(LEAD_STATUS_VALUES, {
  "call scheduled": "Call Scheduled",
  "call done": "Call Done",
  qualified: "Call Done",
  negotiating: "Negotiating",
})

export const normalizeTaxReturnStatus = buildNormalizer(TAX_RETURN_STATUS_VALUES)

export const normalizeDeadlineStatus = buildNormalizer(DEADLINE_STATUS_VALUES, {
  complete: "Completed",
  done: "Completed",
})

// ── Tool-param normalization (used by the propose path before validation) ──

/**
 * Map of approvable tool name → { paramKey: normalizer } for the params that map
 * to a DB enum. Tools not listed have no enum-backed params.
 */
const TOOL_PARAM_NORMALIZERS: Record<string, Record<string, (input: unknown) => string | null>> = {
  create_task: { priority: normalizeTaskPriority, category: normalizeTaskCategory },
  update_task: { priority: normalizeTaskPriority, status: normalizeTaskStatus },
  update_service: { status: normalizeServiceStatus },
  log_conversation: { channel: normalizeConversationChannel },
}

/**
 * Return a copy of `params` with any enum-backed fields normalized to their
 * canonical DB value. If a value is unrecognized, it is left UNCHANGED so the
 * downstream validateToolParams enum check can flag it with a clear error.
 *
 * Pure: never mutates the input. Returns the original reference when there is
 * nothing to normalize (keeps params_hash stable for tools without enum fields).
 */
export function normalizeToolParams(
  toolName: string,
  params: unknown,
): Record<string, unknown> | unknown {
  const map = TOOL_PARAM_NORMALIZERS[toolName]
  if (!map || params === null || typeof params !== "object" || Array.isArray(params)) {
    return params
  }
  const p = params as Record<string, unknown>
  let out: Record<string, unknown> | null = null
  for (const [key, normalize] of Object.entries(map)) {
    if (p[key] === undefined || p[key] === null) continue
    const normalized = normalize(p[key])
    if (normalized !== null && normalized !== p[key]) {
      out = out ?? { ...p }
      out[key] = normalized
    }
  }
  return out ?? params
}
