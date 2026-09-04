/**
 * Staff Alerts — persistent, dismissible notification list sourced from sticky notes
 * (replies, shares, edits) AND Team Workspace (DMs, @mentions, work-channel posts).
 * Staff-only. A client can never reach this (isDashboardUser gate + RLS deny-all on
 * staff_alert_state, same lockdown as staff_notes).
 *
 * GET   — this person's live alerts, newest first (computed, nothing pre-stored)
 * PATCH { kind: 'note_reply' | 'note_update', note_id, reply_id? } — dismiss one note alert
 * PATCH { kind: 'chat_mention' | 'chat_dm' | 'chat_channel', thread_id } — dismiss one chat
 *        alert by marking the thread read (internal_thread_reads) — the SAME write
 *        /api/team/threads/[id]/read makes, not a second dismissal mechanism that
 *        could disagree with Team Chat's own unread state.
 *
 * Deliberately does NOT duplicate reply/done actions — those stay on the existing
 * PATCH /api/crm/staff-notes endpoint (action: 'reply' | 'archive') so an alert-panel
 * reply goes through the exact same validation/guard path as the note editor's own.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { listTeamMembers } from "@/lib/team/directory"
import { notesTable, NOTE_COLUMNS, visibleToOrClause } from "@/lib/notes/staff-notes"
import { computeNoteAlerts, parsedMs, type NoteAlertSourceNote, type DismissalRow } from "@/lib/notes/staff-alerts"
import {
  computeChatAlerts,
  type ChatThreadForAlerts,
  type ChannelMessageForAlerts,
  type ThreadReadPointer,
} from "@/lib/team/chat-alerts"
import type { User } from "@supabase/supabase-js"

export const dynamic = "force-dynamic"

// staff_alert_state is not in the generated Database types yet — same escape hatch as
// staff_notes / staff_note_state / ui_events.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const alertStateTable = () => (supabaseAdmin as any).from("staff_alert_state")

async function currentStaff(): Promise<User | null> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return null
  return user
}

function fail(error: string, status = 400) {
  return NextResponse.json({ error }, { status })
}

/**
 * The chat half, best-effort: a Team Workspace read failure must never take down the
 * notes half of this endpoint (same "never block on a secondary surface" rule
 * sticky-notes-layer.tsx applies to itself). Logged, not surfaced — the only visible
 * effect is chat alerts missing for one refresh, not an error toast for a background
 * aggregation step.
 */
async function loadChatAlerts(userId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const threadsRpc = await (supabaseAdmin as any).rpc("get_team_threads", { p_user_id: userId })
  if (threadsRpc.error || !Array.isArray(threadsRpc.data)) {
    if (threadsRpc.error) console.error("staff-alerts: get_team_threads failed", threadsRpc.error)
    return []
  }
  const threads = threadsRpc.data as ChatThreadForAlerts[]

  // Channel/general unread is NOT threadsRpc's own unread_count (that field means
  // "Threads-panel bugs with new activity" for thread_type='channel' — verified
  // against the live function, see lib/team/chat-alerts.ts) — fetch raw candidates.
  const channelThreadIds = threads
    .filter((t) => t.thread_type === "channel" || t.thread_type === "general")
    .map((t) => t.id)

  let channelMessages: ChannelMessageForAlerts[] = []
  let readPointers: ThreadReadPointer[] = []
  if (channelThreadIds.length > 0) {
    const [msgsRes, readsRes] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabaseAdmin as any)
        .from("internal_messages")
        .select("thread_id, sender_id, sender_name, message, created_at, edited_at, deleted_at, on_behalf_of_user_id")
        .in("thread_id", channelThreadIds)
        .order("created_at", { ascending: false })
        .limit(200),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabaseAdmin as any)
        .from("internal_thread_reads")
        .select("thread_id, last_read_at")
        .eq("user_id", userId)
        .in("thread_id", channelThreadIds),
    ])
    if (msgsRes.error) console.error("staff-alerts: channel message fetch failed", msgsRes.error)
    if (readsRes.error) console.error("staff-alerts: channel read-pointer fetch failed", readsRes.error)
    channelMessages = (msgsRes.data ?? []) as ChannelMessageForAlerts[]
    readPointers = (readsRes.data ?? []) as ThreadReadPointer[]
  }

  const members = (await listTeamMembers())
    .filter((m) => m.role === "admin" || m.role === "team")
    .map((m) => ({ id: m.id, name: m.name }))

  return computeChatAlerts(threads, channelMessages, readPointers, members, userId)
}

export async function GET() {
  const user = await currentStaff()
  if (!user) return fail("Not authorized", 403)

  const [notesRes, dismissalsRes, chatAlerts] = await Promise.all([
    notesTable().select(NOTE_COLUMNS).or(visibleToOrClause(user.id)).order("created_at", { ascending: false }).limit(500),
    alertStateTable().select("note_id, reply_id, dismissed_at").eq("user_id", user.id),
    loadChatAlerts(user.id).catch((err) => {
      console.error("staff-alerts: chat half failed", err)
      return []
    }),
  ])
  if (notesRes.error) return fail(notesRes.error.message || "Could not load alerts.", 500)
  if (dismissalsRes.error) return fail(dismissalsRes.error.message || "Could not load alerts.", 500)

  const noteAlerts = computeNoteAlerts(
    (notesRes.data ?? []) as NoteAlertSourceNote[],
    (dismissalsRes.data ?? []) as DismissalRow[],
    user.id,
    new Date(),
  )

  const alerts = [...noteAlerts, ...chatAlerts].sort((a, b) => parsedMs(b.created_at) - parsedMs(a.created_at))
  return NextResponse.json({ alerts })
}

/** Update-then-insert, never a native upsert: the two dismiss shapes (per-reply vs.
 *  per-note) sit behind two separate PARTIAL unique indexes, and supabase-js's upsert
 *  has no way to target a partial index's WHERE clause. A lost race on rapid double-
 *  dismiss is fine — the insert's own unique-violation (23505) is treated as success,
 *  since "already dismissed" is exactly the outcome wanted. */
async function dismissAlert(userId: string, noteId: string, replyId: string | null): Promise<string | null> {
  const nowIso = new Date().toISOString()
  const table = alertStateTable()

  let updateQuery = table.update({ dismissed_at: nowIso }).eq("user_id", userId).eq("note_id", noteId)
  updateQuery = replyId ? updateQuery.eq("reply_id", replyId) : updateQuery.is("reply_id", null)
  const { data: updated, error: updateErr } = await updateQuery.select("id")
  if (updateErr) return updateErr.message
  if (updated && updated.length > 0) return null

  const { error: insertErr } = await table.insert({
    user_id: userId,
    note_id: noteId,
    reply_id: replyId,
    dismissed_at: nowIso,
  })
  if (insertErr && (insertErr as { code?: string }).code !== "23505") return insertErr.message
  return null
}

export async function PATCH(req: NextRequest) {
  const user = await currentStaff()
  if (!user) return fail("Not authorized", 403)

  const p = await req.json().catch(() => ({}))
  const kind = typeof p.kind === "string" ? p.kind : ""

  if (kind === "note_reply" || kind === "note_update") {
    const noteId = typeof p.note_id === "string" ? p.note_id : ""
    const replyId = typeof p.reply_id === "string" ? p.reply_id : null
    if (!noteId) return fail("Which note?")
    if (kind === "note_reply" && !replyId) return fail("Which reply?")
    const err = await dismissAlert(user.id, noteId, kind === "note_reply" ? replyId : null)
    if (err) return fail(err, 500)
    return NextResponse.json({ ok: true })
  }

  if (kind === "chat_mention" || kind === "chat_dm" || kind === "chat_channel") {
    const threadId = typeof p.thread_id === "string" ? p.thread_id : ""
    if (!threadId) return fail("Which conversation?")
    // Dismissing IS marking the thread read — the exact write
    // /api/team/threads/[id]/read makes. One read pointer, not a second
    // dismissal mechanism that could disagree with Team Chat's own unread state.
    const nowIso = new Date().toISOString()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabaseAdmin as any)
      .from("internal_thread_reads")
      .upsert(
        { thread_id: threadId, user_id: user.id, last_read_at: nowIso, manual_unread: false, updated_at: nowIso },
        { onConflict: "thread_id,user_id" },
      )
    if (error) return fail(error.message || "Could not update that alert.", 500)
    return NextResponse.json({ ok: true })
  }

  return fail("Unknown alert kind.")
}
