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
 * GET ?summary=true               — which clients have unhandled VISIBLE notes (name, count,
 *                                    latest note), newest first, for the New Calendar's
 *                                    What's New tab. Same visibility rules and the same
 *                                    total as the dot (lib/notifications/whats-new-summary.ts).
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
import { isDashboardUser, isStaffUser } from "@/lib/auth"
import { WORKSPACE_SRC_TABLES, soleOpenJobId, srcTableOfRef, type JobLike } from "@/lib/notifications/whats-new-job"
import type { CardInput } from "@/lib/open-services/build"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { suggestedStepFor } from "@/lib/notifications/whats-new-defaults"
import { groupWhatsNewSummary, type SummaryNote } from "@/lib/notifications/whats-new-summary"
import { getClientAccountIds } from "@/lib/portal-auth"
import {
  bucketWhatsNewCounts,
  contactThreadOrFilter,
  linkedContactIdsByAccount,
  multiMemberAccountIds,
} from "@/lib/portal/thread-scope"

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

/** The table half of a note's source ref, read from its marker. */
function srcTableOf(message: string): string {
  return srcTableOfRef(message.match(MARKER_RE)?.[2] ?? null)
}

function parseMarker(message: string): { kind: string | null; src: string | null } {
  const m = message.match(MARKER_RE)
  return { kind: m?.[1] ?? null, src: m?.[2] ?? null }
}

interface EventConfig {
  /** false only if explicitly toggled off; unknown keys default to VISIBLE. */
  visible: boolean
  /** per-event override for the "Open card" suggested next step (Board Settings). */
  suggested_step: string | null
}

/** Per-event config from the whats_new_events catalog (visible + suggested_step). */
async function loadConfig(): Promise<Map<string, EventConfig>> {
  const { data, error } = await supabaseAdmin
    .from("catalog_entries")
    .select("slug, metadata")
    .eq("catalog_id", "whats_new_events")
    .eq("status", "active")
  // Unknown events default to VISIBLE, so a failed read must not break the page — but it must not be silent either.
  if (error) console.error("[whats-new] could not read the event visibility catalog:", error.message)
  const map = new Map<string, EventConfig>()
  for (const r of data ?? []) {
    const m = (r.metadata as Record<string, unknown> | null) ?? {}
    map.set(r.slug as string, {
      visible: m.visible !== false,
      suggested_step: typeof m.suggested_step === "string" ? m.suggested_step : null,
    })
  }
  return map
}

/** For workflow_spawned notes, resolve the linked task → workflow_slug. */
async function resolveTaskSlugs(taskIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>()
  if (taskIds.length === 0) return map
  const { data, error } = await db
    .from("tasks")
    .select("id, workflow_slug")
    .in("id", taskIds)
  if (error) console.error("[whats-new] could not resolve workflow task slugs:", error.message)
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
      const [config, keys] = await Promise.all([loadConfig(), resolveEventKeys(notes)])
      // Hidden only if explicitly toggled off; unknown/unresolved keys show.
      const visible = notes.filter((n) => {
        const key = keys.get(n)
        return !(key && config.get(key)?.visible === false)
      })
      // Company-ONLY notes (contact_id null) must also light the dot on every
      // linked contact's person thread — the person thread is a superset view,
      // mirroring the Messages feed (see lib/portal/thread-scope.ts). Resolve
      // the account → contacts map only for the notes that need it.
      // Multi-member accounts own their thread ("one message, one staff
      // thread", 2026-07-08): their notes light ONLY the account thread's dot.
      const accountOnlyIds = Array.from(
        new Set(visible.filter((n) => n.account_id && !n.contact_id).map((n) => n.account_id as string)),
      )
      const allNoteAccountIds = Array.from(
        new Set(visible.map((n) => n.account_id).filter((id): id is string => !!id)),
      )
      const [contactsByAccount, multiMember] = await Promise.all([
        linkedContactIdsByAccount(accountOnlyIds),
        multiMemberAccountIds(allNoteAccountIds),
      ])
      return NextResponse.json(bucketWhatsNewCounts(visible, contactsByAccount, new Set(multiMember)))
    }

    if (sp.get("summary") === "true") {
      // The cross-client list names every client and their latest note, so it is for STAFF only — isDashboardUser also lets
      // the partner role through (middleware keeps partners out; this is the second lock).
      if (!isStaffUser(user)) return NextResponse.json({ error: "Not authorized" }, { status: 403 })
      // PostgREST silently clips one request to its own row cap (1000 here), so a single `.limit(5000)` could never report
      // "cut off". Read in pages of 1000, newest first, up to MAX_PAGES; if the last allowed page is still full there may be more.
      const PAGE_SIZE = 1000
      const MAX_PAGES = 5
      const rows: RawNote[] = []
      let readTruncated = false
      for (let page = 0; page < MAX_PAGES; page++) {
        const { data, error } = await db
          .from("portal_messages")
          .select("account_id, contact_id, message, created_at")
          .eq("sender_type", "system")
          .ilike("message", "%<!-- chat-event:%")
          .is("handled_at", null)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
        if (error) throw error
        const got = (data ?? []) as RawNote[]
        rows.push(...got)
        if (got.length < PAGE_SIZE) break
        if (page === MAX_PAGES - 1) readTruncated = true
      }
      const [config, keys] = await Promise.all([loadConfig(), resolveEventKeys(rows)])
      // Same visibility rule as the dot: hidden only if explicitly toggled off.
      const notes: SummaryNote[] = rows
        .filter((n) => {
          const key = keys.get(n)
          return !(key && config.get(key)?.visible === false)
        })
        .map((n) => ({
          account_id: n.account_id,
          contact_id: n.contact_id,
          created_at: n.created_at ?? "",
          text: n.message.replace(MARKER_RE, "").trim(),
          event_key: keys.get(n) ?? null,
        }))
      const accountIds = Array.from(new Set(notes.map((n) => n.account_id).filter((id): id is string => !!id)))
      const contactIds = Array.from(new Set(notes.filter((n) => !n.account_id && n.contact_id).map((n) => n.contact_id as string)))
      const chunk = <T,>(arr: T[], size: number): T[][] => {
        const out: T[][] = []
        for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
        return out
      }
      const accounts = new Map<string, string | null>()
      const contacts = new Map<string, string | null>()
      await Promise.all([
        ...chunk(accountIds, 150).map(async (ids) => {
          const { data: a, error: e } = await db.from("accounts").select("id, company_name").in("id", ids)
          // Names are cosmetic: a failed lookup must not take the whole list down (the row falls back to "Unnamed").
          if (e) { console.error("[whats-new] account name lookup failed:", e.message); return }
          for (const r of (a ?? []) as Array<{ id: string; company_name: string | null }>) accounts.set(r.id, r.company_name)
        }),
        ...chunk(contactIds, 150).map(async (ids) => {
          const { data: c, error: e } = await db.from("contacts").select("id, full_name").in("id", ids)
          if (e) { console.error("[whats-new] contact name lookup failed:", e.message); return }
          for (const r of (c ?? []) as Array<{ id: string; full_name: string | null }>) contacts.set(r.id, r.full_name)
        }),
      ])
      return NextResponse.json(groupWhatsNewSummary(notes, { accounts, contacts }, { readTruncated }))
    }

    if (wantNotes) {
      const accountId = sp.get("account_id")
      const contactId = sp.get("contact_id")
      if (!accountId && !contactId) {
        return NextResponse.json({ error: "account_id or contact_id required" }, { status: 400 })
      }
      // Display limit for the feed. The full history is retained in the DB and
      // never auto-purged; "Load older" raises this to page back through it.
      const limitParam = parseInt(sp.get("limit") ?? "100", 10)
      const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 2000) : 100
      let q = db
        .from("portal_messages")
        .select("id, account_id, contact_id, message, topic, created_at, handled_at, handled_by")
        .eq("sender_type", "system")
        .ilike("message", "%<!-- chat-event:%")
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(limit)
      if (accountId) {
        q = q.eq("account_id", accountId)
      } else {
        // Person thread = contact-tagged notes PLUS company-only notes on the
        // contact's linked accounts — the same superset rule the Messages feed
        // applies, via the shared helper so the two can't drift (2026-07-06:
        // member-info notes were company-only and invisible here). Multi-member
        // accounts' notes are excluded — they belong to the account thread
        // ("one message, one staff thread", 2026-07-08); this is a staff-only
        // endpoint so the exclusion always applies.
        const linked = await getClientAccountIds(contactId as string)
        const excluded = await multiMemberAccountIds(linked)
        q = q.or(contactThreadOrFilter(contactId as string, linked, excluded))
      }
      const { data, error } = await q
      if (error) throw error
      const notes = (data ?? []) as RawNote[]
      const [config, keys] = await Promise.all([loadConfig(), resolveEventKeys(notes)])
      // The job whose workspace a note's "Open" can go straight to (the Calendar's What's New tab). Notes do not carry a job id (their marker
      // names the SS-4 / document / lease record), so: for the notes of a COMPANY thread whose record belongs to the company's own work, if the
      // company has EXACTLY ONE open job, that is the job. Several open jobs = ambiguous = no job (the client page stays the target).
      // Only when the caller asks (the Calendar's What's New tab sends want_job=true; Portal Chats does not) and only for STAFF (the partner role
      // passes isDashboardUser): a failed or skipped lookup just leaves job_id empty, never the notes.
      let soleOpenJobIdValue: string | null = null
      if (sp.get("want_job") === "true" && isStaffUser(user) && accountId && notes.some((n) => !n.handled_at && WORKSPACE_SRC_TABLES.has(srcTableOf(n.message)))) {
        const [jobsRes, cardsRes] = await Promise.all([
          db.from("service_deliveries").select("id, status, is_test, service_type, service_type_entry_id").eq("account_id", accountId),
          db
            .from("catalog_entries")
            .select("id, display_name, metadata")
            .eq("catalog_id", "services")
            .or("metadata->>closes_only_by_filing.eq.true,metadata->>hidden_from_open_services.eq.true"),
        ])
        if (jobsRes.error || cardsRes.error) {
          console.error("[whats-new] job lookup failed (Open falls back to the client page):", jobsRes.error?.message ?? cardsRes.error?.message)
        } else {
          soleOpenJobIdValue = soleOpenJobId((jobsRes.data ?? []) as JobLike[], (cardsRes.data ?? []) as CardInput[])
        }
      }
      const out = notes
        .filter((n) => {
          const key = keys.get(n)
          return !(key && config.get(key)?.visible === false)
        })
        .map((n) => {
          // For workflow_spawned notes, expose the linked task id so the panel
          // can render that workflow task's action buttons + SLA inline.
          const m = n.message.match(MARKER_RE)
          const src = m?.[2] ?? null
          const task_id = src && src.startsWith("tasks:") ? src.slice("tasks:".length) : null
          const key = keys.get(n)
          return {
            id: n.id,
            event_key: key,
            task_id,
            // Raw source ref ("payments:uuid", "documents:uuid", ...) so the
            // panel can deep-link the "Open" button to the related entity.
            src,
            // Set only when the note's record belongs to the company's own work AND the company has exactly one open job (see above).
            job_id: !n.handled_at && WORKSPACE_SRC_TABLES.has(srcTableOf(n.message)) ? soleOpenJobIdValue : null,
            topic: n.topic ?? null,
            text: n.message.replace(MARKER_RE, "").trim(),
            // Suggested next step for "Open card": per-event override → code default.
            suggested_step: suggestedStepFor(key, key ? config.get(key)?.suggested_step : null),
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
