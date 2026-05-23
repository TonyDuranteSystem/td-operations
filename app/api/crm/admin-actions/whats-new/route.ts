/**
 * What's New (Notification Center) — the staff feed of incoming client-action
 * notes, their handled state, and per-event visibility.
 *
 * GET ?counts=true                 — per-account/contact count of UNHANDLED,
 *                                    VISIBLE chat-event notes. Drives the PURPLE
 *                                    per-thread dot.
 * GET ?notes=true&account_id|contact_id — the VISIBLE chat-event notes for one
 *                                    client (the What's New feed), enriched with
 *                                    event_key + cleaned text + handled state.
 * POST { message_id, handled }     — tick/untick a note handled. Staff-only.
 *
 * Visibility is catalog-driven (`whats_new_events`, editable in Board Settings).
 * Each note resolves to an event_key: the chat-event `kind`, except
 * `workflow_spawned` notes which key off the linked task's `workflow_slug` (so
 * Formation / Closure / etc. are independent switches). Both the feed and the
 * dot count use the SAME config — single source of truth.
 *
 * Notes are STAFF-ONLY (system chat-event notes are filtered out of the client
 * portal). See sysdoc notification-center-workflow-integration-plan.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"

// Handle for portal_messages handled_at/handled_by ops.
const db = supabaseAdmin

const MARKER_RE = /<!--\s*chat-event:\s*kind=(\S+)\s+src=(\S+)\s*-->/

interface RawNote {
  id?: string
  account_id: string | null
  contact_id: string | null
  message: string
  topic?: string | null
  created_at?: string
  handled_at?: string | null
  handled_by?: string | null
}

function parseMarker(message: string): { kind: string | null; src: string | null } {
  const m = message.match(MARKER_RE)
  return { kind: m?.[1] ?? null, src: m?.[2] ?? null }
}

/** Visibility config: event_key → visible. Unknown keys default to VISIBLE
 *  (never silently hide a brand-new event the catalog hasn't learned yet). */
async function loadVisibility(): Promise<Map<string, boolean>> {
  const { data } = await supabaseAdmin
    .from("catalog_entries")
    .select("slug, metadata")
    .eq("catalog_id", "whats_new_events")
    .eq("status", "active")
  const map = new Map<string, boolean>()
  for (const r of data ?? []) {
    const visible = (r.metadata as Record<string, unknown> | null)?.visible !== false
    map.set(r.slug as string, visible)
  }
  return map
}

/** For workflow_spawned notes, resolve the linked task → workflow_slug. */
async function resolveTaskSlugs(taskIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>()
  if (taskIds.length === 0) return map
  const { data } = await db
    .from("tasks")
    .select("id, workflow_slug")
    .in("id", taskIds)
  for (const t of (data ?? []) as Array<{ id: string; workflow_slug: string | null }>) {
    map.set(t.id, t.workflow_slug ?? null)
  }
  return map
}

/** event_key for a note: the chat-event kind, except workflow_spawned which
 *  keys off the linked task's workflow_slug. Returns null if unresolvable. */
function eventKeyFor(kind: string | null, src: string | null, taskSlugs: Map<string, string | null>): string | null {
  if (!kind) return null
  if (kind !== "workflow_spawned") return kind
  // src = "tasks:<id>"
  const taskId = src && src.startsWith("tasks:") ? src.slice("tasks:".length) : null
  return taskId ? taskSlugs.get(taskId) ?? null : null
}

/** Resolve event_key per note, batching the tasks lookup for workflow_spawned. */
async function resolveEventKeys(notes: RawNote[]): Promise<Map<RawNote, string | null>> {
  const taskIds: string[] = []
  const parsed = notes.map((n) => {
    const p = parseMarker(n.message)
    if (p.kind === "workflow_spawned" && p.src?.startsWith("tasks:")) {
      taskIds.push(p.src.slice("tasks:".length))
    }
    return { note: n, ...p }
  })
  const taskSlugs = await resolveTaskSlugs(Array.from(new Set(taskIds)))
  const out = new Map<RawNote, string | null>()
  for (const { note, kind, src } of parsed) out.set(note, eventKeyFor(kind, src, taskSlugs))
  return out
}

export async function GET(req: NextRequest) {
  try {
    // Staff-only: these notes are internal (about the client). A client must
    // never read them — and the notes endpoint takes an arbitrary account_id /
    // contact_id, so without this gate any authenticated user could read any
    // client's notes. See sysdoc notification-center-workflow-integration-plan.
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || !isDashboardUser(user)) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 })
    }

    const sp = req.nextUrl.searchParams
    const wantCounts = sp.get("counts") === "true"
    const wantNotes = sp.get("notes") === "true"

    if (wantCounts) {
      const { data, error } = await db
        .from("portal_messages")
        .select("account_id, contact_id, message")
        .eq("sender_type", "system")
        .ilike("message", "%<!-- chat-event:%")
        .is("handled_at", null)
        .is("deleted_at", null)
        .limit(5000)
      if (error) throw error
      const notes = (data ?? []) as RawNote[]
      const [visibility, keys] = await Promise.all([loadVisibility(), resolveEventKeys(notes)])
      const by_account: Record<string, number> = {}
      const by_contact: Record<string, number> = {}
      for (const n of notes) {
        const key = keys.get(n)
        // Hidden only if explicitly toggled off; unknown/unresolved keys show.
        if (key && visibility.get(key) === false) continue
        if (n.account_id) by_account[n.account_id] = (by_account[n.account_id] ?? 0) + 1
        else if (n.contact_id) by_contact[n.contact_id] = (by_contact[n.contact_id] ?? 0) + 1
      }
      const total = Object.values(by_account).reduce((s, n) => s + n, 0) +
        Object.values(by_contact).reduce((s, n) => s + n, 0)
      return NextResponse.json({ by_account, by_contact, total })
    }

    if (wantNotes) {
      const accountId = sp.get("account_id")
      const contactId = sp.get("contact_id")
      if (!accountId && !contactId) {
        return NextResponse.json({ error: "account_id or contact_id required" }, { status: 400 })
      }
      let q = db
        .from("portal_messages")
        .select("id, account_id, contact_id, message, topic, created_at, handled_at, handled_by")
        .eq("sender_type", "system")
        .ilike("message", "%<!-- chat-event:%")
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(100)
      if (accountId) q = q.eq("account_id", accountId)
      else q = q.eq("contact_id", contactId as string)
      const { data, error } = await q
      if (error) throw error
      const notes = (data ?? []) as RawNote[]
      const [visibility, keys] = await Promise.all([loadVisibility(), resolveEventKeys(notes)])
      const out = notes
        .filter((n) => {
          const key = keys.get(n)
          return !(key && visibility.get(key) === false)
        })
        .map((n) => {
          // For workflow_spawned notes, expose the linked task id so the panel
          // can render that workflow task's action buttons + SLA inline.
          const m = n.message.match(MARKER_RE)
          const src = m?.[2] ?? null
          const task_id = src && src.startsWith("tasks:") ? src.slice("tasks:".length) : null
          return {
            id: n.id,
            event_key: keys.get(n),
            task_id,
            topic: n.topic ?? null,
            text: n.message.replace(MARKER_RE, "").trim(),
            created_at: n.created_at,
            handled_at: n.handled_at ?? null,
            handled_by: n.handled_by ?? null,
          }
        })
      return NextResponse.json({ notes: out })
    }

    return NextResponse.json({ error: "Unsupported query" }, { status: 400 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    // Staff-only: this writes triage state.
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || !isDashboardUser(user)) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 })
    }

    const { message_id, handled } = await req.json()
    if (!message_id || typeof handled !== "boolean") {
      return NextResponse.json({ error: "Missing message_id or handled" }, { status: 400 })
    }

    const meta = (user.user_metadata ?? {}) as Record<string, unknown>
    const name = (typeof meta.full_name === "string" && meta.full_name) || user.email || user.id

    const { error } = await db
      .from("portal_messages")
      .update(
        handled
          ? { handled_at: new Date().toISOString(), handled_by: name }
          : { handled_at: null, handled_by: null },
      )
      .eq("id", message_id)
      .eq("sender_type", "system") // only system notes carry handled state
    if (error) throw error
    return NextResponse.json({ ok: true, handled })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
