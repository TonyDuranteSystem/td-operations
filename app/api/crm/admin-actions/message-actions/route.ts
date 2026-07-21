/**
 * Message Actions API — staff action tags + Notification Center cards.
 *
 * GET  ?account_id=...  — actions for an account's messages (tag display)
 * GET  ?message_id=...  — action for a specific message
 * GET  ?open=true       — all OPEN actions (resolved_at IS NULL) for the
 *                         Actions view + dashboard board. Includes staff
 *                         Notification Center cards (message_id NULL).
 * POST { message_id, contact_id, account_id, action_type, label?, created_by? }
 *   — upsert a human tag on a message (one per message). message_id required.
 * PATCH { id, action_type, assigned_to?, label? }
 *   — move a card to another column (used by the kanban board). Setting a
 *     TERMINAL column (catalog metadata.terminal=true, e.g. Done) stamps
 *     resolved_at; any non-terminal column clears it.
 *
 * Columns are catalog-driven (catalog_entries, catalog_id='action_board_columns').
 * "Open" is defined by resolved_at IS NULL — NOT by action_type != 'done' — so
 * renaming the Done column never strands cards. See sysdoc notification-center-plan.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { explainFailure } from "@/lib/errors/explain-failure"
import { emitUiEvent } from "@/lib/ui-events"
import { resolveEntityScope } from "@/lib/todo-board/entity-scope"

export const dynamic = "force-dynamic"

/** Staff-only guard. The To-Do board is internal: a client must never read it
 *  (returns all clients' cards) or move/resolve cards. Returns null if allowed,
 *  or a 403 response to return. See sysdoc notification-center-workflow-integration-plan. */
async function requireStaff(): Promise<NextResponse | null> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 })
  }
  return null
}

// Handle for message_actions writes touching remind_at/priority.
const db = supabaseAdmin

const LEGACY_COLUMNS = ["action_needed", "in_progress", "waiting_on_client", "done"]

/**
 * The canonical "open card is currently visible" predicate, as a PostgREST .or()
 * string: a card hidden by snooze (snoozed_until in the future) drops out of every
 * open-card reader until that time. Pair with `.is("resolved_at", null)`.
 * Snooze applies to CARDS only — What's New notes (portal_messages) are unaffected.
 * Single source of truth so the board, the purple-dot count, the To-Do panel, and
 * the summary widget never disagree. See sysdoc
 * notification-center-phase2-cards-summary-plan.
 */
function notSnoozedOr(): string {
  return `snoozed_until.is.null,snoozed_until.lte.${new Date().toISOString()}`
}

/** Active board columns + which are terminal, from the catalog (with a safe fallback). */
async function loadColumns(): Promise<{ valid: Set<string>; terminal: Set<string> }> {
  const valid = new Set<string>()
  const terminal = new Set<string>()
  const { data } = await supabaseAdmin
    .from("catalog_entries")
    .select("slug, metadata")
    .eq("catalog_id", "action_board_columns")
    .eq("status", "active")
  for (const r of data ?? []) {
    valid.add(r.slug as string)
    if ((r.metadata as Record<string, unknown> | null)?.terminal === true) terminal.add(r.slug as string)
  }
  if (valid.size === 0) {
    LEGACY_COLUMNS.forEach((s) => valid.add(s))
    terminal.add("done")
  }
  return { valid, terminal }
}

export async function GET(req: NextRequest) {
  try {
    const denied = await requireStaff()
    if (denied) return denied
    const accountId = req.nextUrl.searchParams.get("account_id")
    const messageId = req.nextUrl.searchParams.get("message_id")
    const openOnly = req.nextUrl.searchParams.get("open") === "true"
    const snoozedOnly = req.nextUrl.searchParams.get("snoozed") === "true"
    const wantColumns = req.nextUrl.searchParams.get("columns") === "true"
    const wantCounts = req.nextUrl.searchParams.get("counts") === "true"

    // Per-thread open-card counts for the purple dot in the portal-chats list.
    // Driven entirely by message_actions (the To-Do board) — NOT the tasks table.
    // `attention` = the thread has a card that is High/Urgent priority OR overdue,
    // so the dot can render brighter.
    if (wantCounts) {
      const { data, error: err } = await db
        .from("message_actions")
        .select("account_id, contact_id, priority, remind_at")
        .is("resolved_at", null)
        .or(notSnoozedOr())
        .limit(2000)
      if (err) throw err
      const by_account: Record<string, number> = {}
      const by_contact: Record<string, number> = {}
      const attention_accounts: Record<string, boolean> = {}
      const attention_contacts: Record<string, boolean> = {}
      const now = Date.now()
      for (const r of (data ?? []) as Array<{
        account_id: string | null
        contact_id: string | null
        priority: string | null
        remind_at: string | null
      }>) {
        const hot =
          r.priority === "high" ||
          r.priority === "urgent" ||
          (r.remind_at != null && new Date(r.remind_at).getTime() < now)
        if (r.account_id) {
          by_account[r.account_id] = (by_account[r.account_id] ?? 0) + 1
          if (hot) attention_accounts[r.account_id] = true
        } else if (r.contact_id) {
          by_contact[r.contact_id] = (by_contact[r.contact_id] ?? 0) + 1
          if (hot) attention_contacts[r.contact_id] = true
        }
      }
      const total = Object.values(by_account).reduce((s, n) => s + n, 0) +
        Object.values(by_contact).reduce((s, n) => s + n, 0)
      return NextResponse.json({ by_account, by_contact, attention_accounts, attention_contacts, total })
    }

    // Board columns (ordered) from the catalog, for the kanban header.
    if (wantColumns) {
      const { data } = await supabaseAdmin
        .from("catalog_entries")
        .select("slug, display_name, metadata")
        .eq("catalog_id", "action_board_columns")
        .eq("status", "active")
      const columns = (data ?? [])
        .map((r) => {
          const m = (r.metadata ?? {}) as Record<string, unknown>
          return {
            slug: r.slug as string,
            display_name: r.display_name as string,
            order: Number(m.order ?? 999),
            terminal: m.terminal === true,
          }
        })
        .sort((a, b) => a.order - b.order)
      return NextResponse.json({ columns })
    }

    // Open feed for the Actions view + dashboard board: open = resolved_at IS NULL.
    // Joins are nullable-safe — staff cards have message_id NULL, so consumers
    // render `label` (the next step) rather than a message preview.
    if (openOnly) {
      // Optional server-side entity filter. The dashboard board fetches ALL open
      // cards (no entity param); the per-entity summary widget passes account_id
      // or contact_id so we never ship every client's cards to one entity page.
      const contactId = req.nextUrl.searchParams.get("contact_id")
      let openQ = db
        .from("message_actions")
        .select(`
          id, action_type, label, assigned_to, source_ref, remind_at, priority, snoozed_until, created_at, updated_at,
          message_id, account_id, contact_id,
          portal_messages(message),
          accounts(company_name),
          contacts(full_name)
        `)
        .is("resolved_at", null)
        .or(notSnoozedOr())
      if (accountId) openQ = openQ.eq("account_id", accountId)
      else if (contactId) openQ = openQ.eq("contact_id", contactId)
      const { data: enriched, error: err } = await openQ
        .order("created_at", { ascending: false })
        .limit(200)
      if (err) throw err
      return NextResponse.json({ actions: enriched })
    }

    // Snoozed feed: open cards currently hidden by a future snoozed_until. Powers
    // the board's "Snoozed" view so a snoozed card is recoverable (un-snooze via
    // PATCH snoozed_until=null) instead of vanishing with no way back.
    if (snoozedOnly) {
      const contactId = req.nextUrl.searchParams.get("contact_id")
      let snoozeQ = db
        .from("message_actions")
        .select(`
          id, action_type, label, assigned_to, source_ref, remind_at, priority, snoozed_until, created_at, updated_at,
          message_id, account_id, contact_id,
          portal_messages(message),
          accounts(company_name),
          contacts(full_name)
        `)
        .is("resolved_at", null)
        .not("snoozed_until", "is", null)
        .gt("snoozed_until", new Date().toISOString())
      if (accountId) snoozeQ = snoozeQ.eq("account_id", accountId)
      else if (contactId) snoozeQ = snoozeQ.eq("contact_id", contactId)
      const { data: snoozed, error: err } = await snoozeQ
        .order("snoozed_until", { ascending: true })
        .limit(200)
      if (err) throw err
      return NextResponse.json({ actions: snoozed })
    }

    // Per-entity tag lookup. MUST be scoped: this branch previously filtered only by
    // message_id or account_id, so a contact-scoped request (portal-chats sends
    // ?contact_id= for a thread with no account) matched NEITHER branch and fell through
    // to an UNFILTERED query — shipping the 200 most-recent cards across EVERY client to
    // the browser. Nothing rendered them (the consumer maps by message_id and staff cards
    // have none), which is why it went unnoticed, but the data still left the server.
    // A request that names no entity is a caller bug: 400 it, the way the sibling
    // whats-new route does, so it can never silently mean "everything".
    const { scope, error: scopeError } = resolveEntityScope({
      messageId,
      accountId,
      contactId: req.nextUrl.searchParams.get("contact_id"),
    })
    if (scopeError || !scope) {
      return NextResponse.json({ error: scopeError ?? "Entity required." }, { status: 400 })
    }

    const { data, error } = await supabaseAdmin
      .from("message_actions")
      .select(
        "id, message_id, contact_id, account_id, action_type, label, assigned_to, source_ref, created_by, resolved_at, created_at",
      )
      .eq(scope.column, scope.value)
      .order("created_at", { ascending: false })
      .limit(200)
    if (error) throw error
    return NextResponse.json({ actions: data })
  } catch (err) {
    // Supabase returns failures as a PLAIN object in the {data,error} tuple (not an
    // Error instance), so the old `String(err)` produced "[object Object]" and hid the
    // real cause. explainFailure reads the live error (Postgres code + message) and
    // returns a readable reason; we also log the technical detail for ourselves. (R099)
    const { message, technical } = explainFailure(err)
    console.error("[message-actions] request failed:", technical)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const denied = await requireStaff()
    if (denied) return denied
    const body = await req.json()
    const { message_id, contact_id, account_id, action_type, label, created_by } = body

    if (!message_id || !action_type) {
      return NextResponse.json({ error: "Missing message_id or action_type" }, { status: 400 })
    }

    const { valid, terminal } = await loadColumns()
    if (!valid.has(action_type)) {
      return NextResponse.json(
        { error: `Invalid action_type. Must be one of: ${Array.from(valid).join(", ")}` },
        { status: 400 },
      )
    }
    const resolvedAt = terminal.has(action_type) ? new Date().toISOString() : null

    // Upsert: one action per message.
    const { data: existing } = await supabaseAdmin
      .from("message_actions")
      .select("id")
      .eq("message_id", message_id)
      .limit(1)
      .maybeSingle()

    if (existing) {
      const updateData: Record<string, unknown> = {
        action_type,
        updated_at: new Date().toISOString(),
        resolved_at: resolvedAt,
        // Re-tagging / re-adding a To-Do from the message menu is an explicit
        // "make this active now" — so clear any snooze. Without this, re-adding a
        // To-Do on a snoozed card silently succeeds but the card stays hidden
        // (the open-card readers filter out snoozed cards), which looks like
        // "nothing happened". Also the only un-snooze control lived on the now-
        // hidden card, so this is the primary recovery path. See the Snoozed view
        // on the board for the secondary path.
        snoozed_until: null,
      }
      if (label !== undefined) updateData.label = label
      if (created_by) updateData.created_by = created_by

      const { data, error } = await supabaseAdmin
        .from("message_actions")
        .update(updateData)
        .eq("id", existing.id)
        .select()
        .single()
      if (error) throw error
      void emitUiEvent("todo") // live-refresh boards in all open tabs
      return NextResponse.json({ action: data, updated: true })
    }

    const { data, error } = await supabaseAdmin
      .from("message_actions")
      .insert({
        message_id,
        contact_id: contact_id || null,
        account_id: account_id || null,
        action_type,
        label: label || null,
        created_by: created_by || null,
        resolved_at: resolvedAt,
      })
      .select()
      .single()
    if (error) throw error
    void emitUiEvent("todo") // live-refresh boards in all open tabs
    return NextResponse.json({ action: data, created: true })
  } catch (err) {
    // Supabase returns failures as a PLAIN object in the {data,error} tuple (not an
    // Error instance), so the old `String(err)` produced "[object Object]" and hid the
    // real cause. explainFailure reads the live error (Postgres code + message) and
    // returns a readable reason; we also log the technical detail for ourselves. (R099)
    const { message, technical } = explainFailure(err)
    console.error("[message-actions] request failed:", technical)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const denied = await requireStaff()
    if (denied) return denied
    const body = await req.json()
    const { id, action_type, assigned_to, label, remind_at, priority, snoozed_until } = body

    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 })
    }
    // At least one mutable field must be present (move OR reminder/priority/snooze edit).
    if (
      action_type === undefined &&
      assigned_to === undefined &&
      label === undefined &&
      remind_at === undefined &&
      priority === undefined &&
      snoozed_until === undefined
    ) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
    }

    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() }

    // Column move (optional). Setting a terminal column resolves the card.
    if (action_type !== undefined) {
      const { valid, terminal } = await loadColumns()
      if (!valid.has(action_type)) {
        return NextResponse.json(
          { error: `Invalid action_type. Must be one of: ${Array.from(valid).join(", ")}` },
          { status: 400 },
        )
      }
      updateData.action_type = action_type
      updateData.resolved_at = terminal.has(action_type) ? new Date().toISOString() : null
    }

    if (assigned_to !== undefined) updateData.assigned_to = assigned_to
    if (label !== undefined) updateData.label = label
    // remind_at: ISO string to set, null/"" to clear.
    if (remind_at !== undefined) updateData.remind_at = remind_at || null
    // snoozed_until: ISO string to hide the card until that time; null/"" to un-snooze.
    if (snoozed_until !== undefined) updateData.snoozed_until = snoozed_until || null
    if (priority !== undefined) {
      if (!["normal", "high", "urgent"].includes(priority)) {
        return NextResponse.json({ error: "Invalid priority" }, { status: 400 })
      }
      updateData.priority = priority
    }

    const { data, error } = await db
      .from("message_actions")
      .update(updateData)
      .eq("id", id)
      .select()
      .single()
    if (error) throw error
    void emitUiEvent("todo") // live-refresh boards in all open tabs
    return NextResponse.json({ action: data, moved: action_type !== undefined })
  } catch (err) {
    // Supabase returns failures as a PLAIN object in the {data,error} tuple (not an
    // Error instance), so the old `String(err)` produced "[object Object]" and hid the
    // real cause. explainFailure reads the live error (Postgres code + message) and
    // returns a readable reason; we also log the technical detail for ourselves. (R099)
    const { message, technical } = explainFailure(err)
    console.error("[message-actions] request failed:", technical)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
