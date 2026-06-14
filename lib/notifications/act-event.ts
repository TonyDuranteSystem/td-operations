/**
 * Notification Center — fresh client-action → staff-only action card.
 *
 * See sysdoc `notification-center-plan` (dev_task 529b26cc).
 *
 * When a client does something that needs TD to act (submits ITIN/formation/
 * tax/banking info, signs SS-4, signs a tax return), `emitActionNeeded` creates
 * a STAFF-ONLY card by inserting a `message_actions` row with `message_id = NULL`.
 * Nothing is ever written to the client's chat thread — this is leak-safe by
 * construction (the client chat API only reads `portal_messages`).
 *
 * The card carries: scope (contact/account), owner (assigned_to), the next step
 * (label), the first kanban column (action_type), and an idempotency key
 * (source_ref). It surfaces in the portal-chats Actions view and the dashboard
 * board. It is NOT a CRM task and never advances a pipeline.
 *
 * Catalog-driven: next-step / scope / owner come from the `action_events`
 * catalog, columns from `action_board_columns` — both editable without a deploy.
 *
 * Design mirrors lib/chat/quick-actions.ts: pure helpers (unit-tested) +
 * a thin DB loader (integration-tested via the routes + sandbox QA).
 *
 * NON-FATAL by contract: every failure logs and returns — it must never throw
 * into the calling route, because creating the awareness card must not roll
 * back the real client-action handling.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { defaultTaskAssignee } from "@/lib/tasks/default-assignee"

// Handle for message_actions ops (assigned_to / source_ref now in generated types).
const db = supabaseAdmin

/** Catalog slugs in `action_events`. Keep in sync with the seed migration. */
export type ActEvent =
  | "itin_wizard_submitted"
  | "formation_wizard_submitted"
  | "onboarding_wizard_submitted"
  | "tax_wizard_submitted"
  | "banking_wizard_submitted"
  | "ss4_signed"
  | "tax_return_signed"
  | "itin_number_provided"
  | "ra_renewal_upcoming"
  | "annual_report_upcoming"
  | "itin_renewal_upcoming"

export interface ActionEventMeta {
  next_step: string
  scope: "contact" | "account"
  default_assignee?: string
}

export interface BoardColumn {
  slug: string
  order: number
  terminal?: boolean
}

export interface ActionCardInsert {
  contact_id: string | null
  account_id: string | null
  action_type: string
  label: string
  assigned_to: string
  source_ref: string
  message_id: null
}

export interface ResolveResult {
  /** The card to insert, or null when the event can't be carded. */
  card: ActionCardInsert | null
  reason?: "unknown_event" | "missing_scope_id"
}

export interface EmitActionNeededParams {
  event: ActEvent
  contact_id?: string | null
  account_id?: string | null
  /** Stable idempotency key, e.g. `itin_submission:<id>` or `ss4:<id>`. */
  source_ref: string
}

export interface EmitResult {
  created: boolean
  id?: string
  reason?: "unknown_event" | "missing_scope_id" | "already_open" | "insert_failed" | "error"
}

// ─── Pure helpers (unit-tested, no DB) ──────────────────────────────────────

/**
 * The column a brand-new card lands in: the lowest-`order` NON-terminal column.
 * Falls back to "action_needed" if the catalog returned nothing usable.
 */
export function pickInitialColumn(columns: BoardColumn[]): string {
  const open = columns.filter((c) => !c.terminal)
  if (open.length === 0) return "action_needed"
  return open.reduce((best, c) => (c.order < best.order ? c : best)).slug
}

/**
 * Build the card payload from event meta + the ids the caller has. Pure.
 *
 * Scope routing is enforced here: a `contact` event (e.g. ITIN) ALWAYS lands on
 * the contact with `account_id` forced null — even if an account_id was passed —
 * because ITIN/personal work belongs to the person, never the company. An
 * `account` event keeps a passed contact_id only for linking.
 */
export function resolveActionCard(args: {
  meta: ActionEventMeta | null
  initialColumn: string
  contact_id?: string | null
  account_id?: string | null
  source_ref: string
  fallbackAssignee: string
}): ResolveResult {
  const { meta, initialColumn, contact_id, account_id, source_ref, fallbackAssignee } = args
  if (!meta) return { card: null, reason: "unknown_event" }

  let cardContact: string | null
  let cardAccount: string | null
  if (meta.scope === "contact") {
    if (!contact_id) return { card: null, reason: "missing_scope_id" }
    cardContact = contact_id
    cardAccount = null
  } else {
    if (!account_id) return { card: null, reason: "missing_scope_id" }
    cardAccount = account_id
    cardContact = contact_id ?? null
  }

  const assigned =
    meta.default_assignee && meta.default_assignee.trim().length > 0
      ? meta.default_assignee.trim()
      : fallbackAssignee

  return {
    card: {
      contact_id: cardContact,
      account_id: cardAccount,
      action_type: initialColumn,
      label: meta.next_step,
      assigned_to: assigned,
      source_ref,
      message_id: null,
    },
  }
}

// ─── DB I/O (integration-tested via routes + sandbox QA) ────────────────────

export async function emitActionNeeded(params: EmitActionNeededParams): Promise<EmitResult> {
  try {
    // 1. Idempotency: skip if an OPEN card already exists for this source.
    //    (resolved_at IS NULL = open; a re-submission after Done makes a new card.)
    const { data: existingRows } = await db
      .from("message_actions")
      .select("id")
      .eq("source_ref", params.source_ref)
      .is("resolved_at", null)
      .limit(1)
    if (existingRows && existingRows.length > 0) {
      return { created: false, id: existingRows[0].id as string, reason: "already_open" }
    }

    // 2. Load event meta + columns from the catalog.
    const [evRes, colRes] = await Promise.all([
      db
        .from("catalog_entries")
        .select("metadata")
        .eq("catalog_id", "action_events")
        .eq("slug", params.event)
        .eq("status", "active")
        .maybeSingle(),
      db
        .from("catalog_entries")
        .select("slug, metadata")
        .eq("catalog_id", "action_board_columns")
        .eq("status", "active"),
    ])

    const meta = (evRes.data?.metadata ?? null) as unknown as ActionEventMeta | null
    const columns: BoardColumn[] = (colRes.data ?? []).map((r) => {
      const m = (r.metadata ?? {}) as Record<string, unknown>
      return { slug: r.slug as string, order: Number(m.order ?? 999), terminal: m.terminal === true }
    })

    const resolved = resolveActionCard({
      meta,
      initialColumn: pickInitialColumn(columns),
      contact_id: params.contact_id,
      account_id: params.account_id,
      source_ref: params.source_ref,
      fallbackAssignee: defaultTaskAssignee(),
    })
    if (!resolved.card) {
      console.warn(
        `[emitActionNeeded] skip event=${params.event} source_ref=${params.source_ref}: ${resolved.reason}`,
      )
      return { created: false, reason: resolved.reason }
    }

    // 3. Insert the staff-only card. NEVER writes portal_messages.
    const { data: inserted, error } = await db
      .from("message_actions")
      .insert(resolved.card)
      .select("id")
      .single()
    if (error || !inserted) {
      console.warn(`[emitActionNeeded] insert failed event=${params.event}: ${error?.message ?? "no row"}`)
      return { created: false, reason: "insert_failed" }
    }
    return { created: true, id: inserted.id as string }
  } catch (err) {
    console.warn(
      `[emitActionNeeded] non-fatal error event=${params.event}:`,
      err instanceof Error ? err.message : String(err),
    )
    return { created: false, reason: "error" }
  }
}
