/**
 * Staff Alerts — persistent, dismissible notification list sourced from sticky notes
 * (replies, shares, edits). Staff-only. A client can never reach this (isDashboardUser
 * gate + RLS deny-all on staff_alert_state, same lockdown as staff_notes).
 *
 * GET   — this person's live alerts, newest first (computed, nothing pre-stored)
 * PATCH { kind: 'note_reply' | 'note_update', note_id, reply_id? } — dismiss one
 *
 * Deliberately does NOT duplicate reply/done actions — those stay on the existing
 * PATCH /api/crm/staff-notes endpoint (action: 'reply' | 'archive') so an alert-panel
 * reply goes through the exact same validation/guard path as the note editor's own.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { notesTable, NOTE_COLUMNS, visibleToOrClause } from "@/lib/notes/staff-notes"
import { computeNoteAlerts, type NoteAlertSourceNote, type DismissalRow } from "@/lib/notes/staff-alerts"
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

export async function GET() {
  const user = await currentStaff()
  if (!user) return fail("Not authorized", 403)

  const [notesRes, dismissalsRes] = await Promise.all([
    notesTable().select(NOTE_COLUMNS).or(visibleToOrClause(user.id)).order("created_at", { ascending: false }).limit(500),
    alertStateTable().select("note_id, reply_id, dismissed_at").eq("user_id", user.id),
  ])
  if (notesRes.error) return fail(notesRes.error.message || "Could not load alerts.", 500)
  if (dismissalsRes.error) return fail(dismissalsRes.error.message || "Could not load alerts.", 500)

  const alerts = computeNoteAlerts(
    (notesRes.data ?? []) as NoteAlertSourceNote[],
    (dismissalsRes.data ?? []) as DismissalRow[],
    user.id,
    new Date(),
  )
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
  const noteId = typeof p.note_id === "string" ? p.note_id : ""
  const replyId = typeof p.reply_id === "string" ? p.reply_id : null
  if (!noteId) return fail("Which note?")
  if (kind !== "note_reply" && kind !== "note_update") return fail("Unknown alert kind.")
  if (kind === "note_reply" && !replyId) return fail("Which reply?")

  const err = await dismissAlert(user.id, noteId, kind === "note_reply" ? replyId : null)
  if (err) return fail(err, 500)
  return NextResponse.json({ ok: true })
}
