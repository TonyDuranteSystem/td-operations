/**
 * Pure Zod definitions for every workflow handler's `handler_params` shape.
 *
 * Why this exists separately from the handler files: each handler module
 * imports server-only dependencies (`supabaseAdmin`, `gmail`, etc.). The
 * workflow editor is a client component and needs to read these schemas to
 * auto-render forms — importing them from the handler files would drag
 * server-only modules into the client bundle.
 *
 * This file is pure Zod. No server deps. Safe to import from anywhere.
 *
 * Each handler file re-exports its named schema from here as
 * `handlerParamsSchema` so handler-side consumers (the handler itself and
 * the central registry) use the same object — single source of truth.
 */

import { z } from "zod"

// ── Task lifecycle handlers ────────────────────────────────────────────

/** Trivial handler, no catalog-configurable params. Optional `reason` from requires_input. */
export const taskCancelParams = z.object({}).strict()

/** Trivial: operator's note comes from requires_input.note at action time. */
export const taskFlagBlockedParams = z.object({}).strict()

/** Operator's new assignee comes from requires_input.assigned_to. */
export const taskReassignParams = z.object({}).strict()

/** Snooze until_date comes from requires_input. */
export const taskSnoozeParams = z.object({}).strict()

/** Optional bilingual message + status come from requires_input. */
export const taskWaitingParams = z.object({}).strict()

// ── Chain primitives ────────────────────────────────────────────────────

/**
 * Target stage (pipeline_stages.name) the SD advances to on success.
 * Can also be supplied at runtime via ctx.params for operator-input flows;
 * handler prefers params over handler_params.
 */
export const chainAdvanceSdStageParams = z.object({
  target_stage: z.string().min(1),
})

/**
 * All three optional — Slice 5's catalog `workflow_chain.transitions` lookup
 * is the preferred pattern (leave empty to let the dispatcher resolve from
 * the parent service's chain). Explicit workflow_slug forces a target.
 */
export const chainSpawnNextWorkflowParams = z.object({
  workflow_slug: z.string().min(1).optional(),
  task_meta: z.record(z.string(), z.unknown()).optional(),
  assigned_to: z.string().min(1).optional(),
})

/** Message body (en/it) comes from operator's requires_input. */
export const chainSendClientMessageParams = z.object({}).strict()

/** Recipient, subject, body come from operator's requires_input. */
export const chainSendEmailParams = z.object({}).strict()

/** STUB — schema will be filled when the real handler ships (dev_task cc94b8d9). */
export const chainSendForSignatureParams = z.object({}).strict()

/** Optional awaiting_note from requires_input. */
export const chainAwaitClientActionParams = z.object({}).strict()

/** STUB — schema will be filled when the real handler ships (dev_task 57a4df71). */
export const chainUploadDocumentParams = z.object({}).strict()

/**
 * field = contacts.* column to update (always required at design time).
 * value = optional static value; when absent, operator supplies via ctx.params.
 * Scalar union only — arbitrary nested JSON isn't a valid contact column shape.
 */
export const chainUpdateContactFieldParams = z.object({
  field: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
})

/** Same shape as chain.update_contact_field for the accounts.* table. */
export const chainUpdateAccountFieldParams = z.object({
  field: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
})

// ── Service-specific handlers ───────────────────────────────────────────

/** ITIN: no catalog-configurable params (content composed from task_meta + service config). */
export const itinApproveAndSendParams = z.object({}).strict()

/** ITIN: number / issue date / IRS-letter URL come from operator's requires_input. */
export const itinConfirmNumberReceivedParams = z.object({}).strict()

/** ITIN: recall reason comes from operator's requires_input. */
export const itinRecallAndRecorrectParams = z.object({}).strict()

/**
 * Banking: provider-specific follow-up task copy lives in handler_params.followup_task.
 * Adding a new banking provider = one catalog INSERT with these fields filled in.
 */
const FollowupTaskSpec = z.object({
  title_template: z.string().min(1),
  description_template: z.string().min(1),
  assignee: z.string().min(1),
  priority: z.enum(["Urgent", "High", "Normal", "Low"]),
  category: z.string().min(1),
})
export const bankingApproveFormParams = z.object({
  followup_task: FollowupTaskSpec,
})

/** Tax: no catalog-configurable params (handler kicks off the post-review job). */
export const taxApproveAndApplyParams = z.object({}).strict()

/** Closure: target stage is hardcoded inside the handler (State Compliance Check). */
export const closureApproveDataParams = z.object({}).strict()

/** Formation: EIN comes from operator's requires_input.ein_number. */
export const formationConfirmEinReceivedParams = z.object({}).strict()

/**
 * Generic SD-lifecycle close primitive.
 *
 * spawn_next_sds: array of service_type names to createSD for after the
 * parent SD is marked complete (e.g. ['State RA Renewal', 'State Annual Report']
 * for formation_progress). Each spawned SD fires its own dispatcher hook.
 *
 * send_review_request: when true, fires the "leave us a review" portal
 * notification to the primary contact after the SD closes.
 */
export const sdMarkCompleteParams = z.object({
  spawn_next_sds: z.array(z.string().min(1)).optional(),
  send_review_request: z.boolean().optional(),
})
