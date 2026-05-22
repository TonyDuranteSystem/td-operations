"use server"

/**
 * Server actions for the Notification Center board COLUMNS, editable from the
 * dashboard UI (no deploy needed). Writes to the `action_board_columns` catalog
 * via the framework (audit-logged). The board + the message-actions API already
 * read columns from this catalog, so edits reflect immediately.
 *
 * Rename changes display_name only — the slug (stored on cards as action_type)
 * stays stable, so renaming a column never orphans its cards. See sysdoc
 * notification-center-plan / dev_task 529b26cc.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { safeAction, type ActionResult } from "@/lib/server-action"
import {
  type Actor,
  addEntry,
  deprecateEntry,
  listEntries,
  renameEntry,
  restoreEntry,
  updateMetadata,
} from "@/lib/catalog/framework"

// Loose handle for message_actions writes touching remind_at/priority — not in
// the generated Database types until the migration is promoted to prod + types
// regenerated. Mirrors lib/notifications/act-event.ts. Remove after type regen.
// eslint-disable-next-line no-restricted-syntax -- temporary until prod type regen; see sysdoc notification-center-plan
const db = supabaseAdmin as unknown as SupabaseClient

const CATALOG = "action_board_columns"
const EVENTS = "action_events"
const EVENTS_REASON = "Edited Notification Center card wording via dashboard UI"
const REASON = "Edited Notification Center board columns via dashboard UI"

async function uiActor(): Promise<Actor> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) throw new Error("Not authorized")
  return { kind: "ui", userId: user.id }
}

/** Like uiActor but also returns a human label for `created_by` (who acted) —
 *  used so the shared "handled by …" marker on a What's New note is readable. */
async function uiActorAndName(): Promise<{ actor: Actor; name: string }> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) throw new Error("Not authorized")
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>
  const name = (typeof meta.full_name === "string" && meta.full_name) || user.email || user.id
  return { actor: { kind: "ui", userId: user.id }, name }
}

export interface BoardColumnRow {
  id: string
  slug: string
  display_name: string
  order: number
  terminal: boolean
}

function toRow(e: { id: string; slug: string; display_name: string; metadata: unknown }): BoardColumnRow {
  const m = (e.metadata ?? {}) as Record<string, unknown>
  return {
    id: e.id,
    slug: e.slug,
    display_name: e.display_name,
    order: Number(m.order ?? 999),
    terminal: m.terminal === true,
  }
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "column"
}

/** Active columns, ordered, with the ids the editor needs. */
export async function listBoardColumns(): Promise<ActionResult<BoardColumnRow[]>> {
  return safeAction(async () => {
    await uiActor()
    const entries = await listEntries(CATALOG, {})
    return entries.map(toRow).sort((a, b) => a.order - b.order)
  })
}

export async function addBoardColumn(name: string): Promise<ActionResult<BoardColumnRow>> {
  return safeAction(async () => {
    const actor = await uiActor()
    const clean = name.trim()
    if (!clean) throw new Error("Column name is required")
    const existing = await listEntries(CATALOG, {})
    const rows = existing.map(toRow)
    // unique slug
    let slug = slugify(clean)
    if (rows.some((r) => r.slug === slug)) slug = `${slug}_${Date.now().toString(36).slice(-4)}`
    const maxOrder = rows.reduce((mx, r) => Math.max(mx, r.order), 0)
    const created = await addEntry(
      CATALOG,
      { slug, display_name: clean, status: "active", metadata: { order: maxOrder + 10 } },
      REASON,
      actor,
    )
    revalidatePath("/")
    return toRow(created)
  })
}

export async function renameBoardColumn(id: string, name: string): Promise<ActionResult<true>> {
  return safeAction(async () => {
    const actor = await uiActor()
    const clean = name.trim()
    if (!clean) throw new Error("Column name is required")
    await renameEntry(id, clean, REASON, actor)
    revalidatePath("/")
    return true as const
  })
}

/** Move a column left/right by swapping its order with the adjacent column. */
export async function moveBoardColumn(id: string, direction: "left" | "right"): Promise<ActionResult<true>> {
  return safeAction(async () => {
    const actor = await uiActor()
    const rows = (await listEntries(CATALOG, {})).map(toRow).sort((a, b) => a.order - b.order)
    const idx = rows.findIndex((r) => r.id === id)
    if (idx === -1) throw new Error("Column not found")
    const swapIdx = direction === "left" ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= rows.length) return true as const // already at the edge
    const a = rows[idx]
    const b = rows[swapIdx]
    const entries = await listEntries(CATALOG, {})
    const metaA = { ...((entries.find((e) => e.id === a.id)?.metadata as Record<string, unknown>) ?? {}), order: b.order }
    const metaB = { ...((entries.find((e) => e.id === b.id)?.metadata as Record<string, unknown>) ?? {}), order: a.order }
    await updateMetadata(a.id, metaA, REASON, actor)
    await updateMetadata(b.id, metaB, REASON, actor)
    revalidatePath("/")
    return true as const
  })
}

/** Mark/unmark a column as the one that CLOSES a card (resolves it). */
export async function setBoardColumnTerminal(id: string, terminal: boolean): Promise<ActionResult<true>> {
  return safeAction(async () => {
    const actor = await uiActor()
    const entries = await listEntries(CATALOG, {})
    const cur = entries.find((e) => e.id === id)
    if (!cur) throw new Error("Column not found")
    const meta = { ...((cur.metadata as Record<string, unknown>) ?? {}) }
    if (terminal) meta.terminal = true
    else delete meta.terminal
    await updateMetadata(id, meta, REASON, actor)
    revalidatePath("/")
    return true as const
  })
}

/**
 * Remove (deprecate) a column. Blocked if OPEN cards still sit in it — the user
 * must move those cards out first, otherwise they would vanish from the board.
 */
export async function removeBoardColumn(id: string, slug: string): Promise<ActionResult<true>> {
  return safeAction(async () => {
    const actor = await uiActor()
    const { count } = await supabaseAdmin
      .from("message_actions")
      .select("id", { count: "exact", head: true })
      .eq("action_type", slug)
      .is("resolved_at", null)
    if ((count ?? 0) > 0) {
      throw new Error(`This column still has ${count} open card(s). Move them to another column first, then delete it.`)
    }
    await deprecateEntry(id, REASON, actor)
    revalidatePath("/")
    return true as const
  })
}

// ─── Card wording (action_events) ────────────────────────────────────────────
// Events are wired in code (each route calls a fixed event slug), so they are
// NOT add/removable from the UI — only the card TEXT and the on/off switch.

export interface ActionEventRow {
  id: string
  slug: string
  display_name: string
  next_step: string
  enabled: boolean
}

export async function listActionEvents(): Promise<ActionResult<ActionEventRow[]>> {
  return safeAction(async () => {
    await uiActor()
    const entries = await listEntries(EVENTS, { includeDeprecated: true })
    return entries
      .map((e) => {
        const m = (e.metadata ?? {}) as Record<string, unknown>
        return {
          id: e.id,
          slug: e.slug,
          display_name: e.display_name,
          next_step: typeof m.next_step === "string" ? m.next_step : "",
          enabled: e.status === "active",
        }
      })
      .sort((a, b) => a.display_name.localeCompare(b.display_name))
  })
}

export async function updateActionEventText(id: string, nextStep: string): Promise<ActionResult<true>> {
  return safeAction(async () => {
    const actor = await uiActor()
    const clean = nextStep.trim()
    if (!clean) throw new Error("Card text is required")
    const entries = await listEntries(EVENTS, { includeDeprecated: true })
    const cur = entries.find((e) => e.id === id)
    if (!cur) throw new Error("Event not found")
    const meta = { ...((cur.metadata as Record<string, unknown>) ?? {}), next_step: clean }
    await updateMetadata(id, meta, EVENTS_REASON, actor)
    revalidatePath("/")
    return true as const
  })
}

export async function setActionEventEnabled(id: string, enabled: boolean): Promise<ActionResult<true>> {
  return safeAction(async () => {
    const actor = await uiActor()
    if (enabled) await restoreEntry(id, EVENTS_REASON, actor)
    else await deprecateEntry(id, EVENTS_REASON, actor)
    revalidatePath("/")
    return true as const
  })
}

// ─── Manual cards ────────────────────────────────────────────────────────────
// A staff-placed card (not from a client event). Uses only existing
// message_actions columns (message_id NULL = staff-only, never client chat).

export type CardPriority = "normal" | "high" | "urgent"

export async function createManualCard(input: {
  label: string
  account_id?: string | null
  contact_id?: string | null
  action_type?: string
  remind_at?: string | null
  priority?: CardPriority
  /** Links the card back to the What's New note it was created from, e.g.
   *  "payments:<id>". Matches the chat-event marker's `src=`. Enables the
   *  shared "handled" indicator + dedup. */
  source_ref?: string | null
}): Promise<ActionResult<true>> {
  return safeAction(async () => {
    const { name } = await uiActorAndName()
    const label = (input.label || "").trim()
    if (!label) throw new Error("Write what needs to be done")
    if (!input.account_id && !input.contact_id) throw new Error("Pick a client for this card")

    // Land in the chosen column if valid + non-terminal, else the first column.
    const cols = (await listEntries(CATALOG, {})).map(toRow).sort((a, b) => a.order - b.order)
    const firstOpen = cols.find((c) => !c.terminal)?.slug ?? "action_needed"
    const chosen = cols.find((c) => c.slug === input.action_type)
    const action_type = chosen && !chosen.terminal ? chosen.slug : firstOpen

    const priority: CardPriority =
      input.priority && ["normal", "high", "urgent"].includes(input.priority) ? input.priority : "normal"

    const { error } = await db.from("message_actions").insert({
      message_id: null,
      account_id: input.account_id ?? null,
      contact_id: input.contact_id ?? null,
      action_type,
      label,
      remind_at: input.remind_at || null,
      priority,
      source_ref: input.source_ref || null,
      created_by: name,
    })
    if (error) throw new Error(error.message)
    revalidatePath("/")
    return true as const
  })
}
