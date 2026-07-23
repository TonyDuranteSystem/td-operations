/**
 * Staff sticky notes API — staff-only. Service-role writes behind requireStaff() + the one
 * visibility rule in lib/notes/staff-notes.ts. A client can never reach this (isDashboardUser
 * gate + RLS deny-all on the table).
 *
 * GET  ?scope=active           — the floating feed: notes visible to ME, live, not snoozed
 * GET  ?account_id=... | ?contact_id=... — notes visible to ME on that record (page widget)
 * POST { body, color?, account_id?, contact_id?, origin_url? } — create (mine, private)
 * PATCH { id, action, ... }    — edit | snooze | share | team | private | archive | unarchive
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser, getUserDisplayName } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { emitUiEvent } from "@/lib/ui-events"
import { sendPushToAdminUsers } from "@/lib/portal/web-push"
import { listTeamMembers } from "@/lib/team/directory"
import {
  notesTable,
  NOTE_COLUMNS,
  listAllNotesForUser,
  listActiveNotesForUser,
  listNotesForAccount,
  listNotesForContact,
  validateNoteBody,
  safeOriginPath,
  computeSnoozeUntil,
} from "@/lib/notes/staff-notes"
import type { User } from "@supabase/supabase-js"

export const dynamic = "force-dynamic"

async function currentStaff(): Promise<User | null> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return null
  return user
}

/**
 * Record MY done/snooze for a note, leaving everyone else's alone.
 *
 * A note is one thing; "I have dealt with it" is per person. Writing this to the
 * note's own columns is what made Antonio's Done clear the note off Luca's
 * screen too (2026-07-23).
 *
 * Upsert on the (note, person) pair, and pass ONLY the field being changed —
 * an upsert writes exactly the columns in the payload, so including both would
 * let "snooze" silently wipe an existing "done" and vice versa.
 */
async function setMyNoteState(
  noteId: string,
  userId: string,
  patch: { archived_at?: string | null; snoozed_until?: string | null },
): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabaseAdmin as any)
    .from("staff_note_state")
    .upsert(
      { note_id: noteId, user_id: userId, ...patch, updated_at: new Date().toISOString() },
      { onConflict: "note_id,user_id" },
    )
  return error ? error.message : null
}

function fail(error: string, status = 400) {
  return NextResponse.json({ error }, { status })
}

export async function GET(req: NextRequest) {
  const user = await currentStaff()
  if (!user) return fail("Not authorized", 403)

  const sp = req.nextUrl.searchParams
  const accountId = sp.get("account_id")
  const contactId = sp.get("contact_id")

  try {
    if (accountId) {
      const res = await listNotesForAccount(user.id, accountId)
      if (res.error) return fail(res.error.message || "Could not load notes.", 500)
      return NextResponse.json({ notes: res.data ?? [] })
    }
    if (contactId) {
      const res = await listNotesForContact(user.id, contactId)
      if (res.error) return fail(res.error.message || "Could not load notes.", 500)
      return NextResponse.json({ notes: res.data ?? [] })
    }
    // scope=all → the Notes page (everything visible to me, incl. snoozed + done)
    // otherwise → the floating feed (live, not snoozed)
    const res = sp.get("scope") === "all"
      ? await listAllNotesForUser(user.id)
      : await listActiveNotesForUser(user.id, new Date().toISOString())
    if (res.error) return fail(res.error.message || "Could not load notes.", 500)
    const members = (await listTeamMembers())
      .filter((m) => (m.role === "admin" || m.role === "team") && m.id !== user.id)
      .map((m) => ({ id: m.id, name: m.name }))
    return NextResponse.json({
      notes: res.data ?? [],
      me: { id: user.id, name: getUserDisplayName(user) },
      members,
    })
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Could not load notes.", 500)
  }
}

export async function POST(req: NextRequest) {
  const user = await currentStaff()
  if (!user) return fail("Not authorized", 403)

  const payload = await req.json().catch(() => ({}))
  const { body, error: bodyErr } = validateNoteBody(payload.body)
  if (bodyErr || !body) return fail(bodyErr ?? "A note needs some text.")

  const origin = payload.origin_url != null ? safeOriginPath(payload.origin_url) : null
  const color = typeof payload.color === "string" && payload.color.trim() ? payload.color.trim() : "yellow"

  const insert = {
    body,
    color,
    author_user_id: user.id,
    author_name: getUserDisplayName(user),
    visibility: "private" as const,
    account_id: typeof payload.account_id === "string" ? payload.account_id : null,
    contact_id: typeof payload.contact_id === "string" ? payload.contact_id : null,
    origin_url: origin,
  }

  const { data, error } = await notesTable().insert(insert).select(NOTE_COLUMNS).single()
  if (error) return fail(error.message || "Could not save the note.", 500)

  emitUiEvent("notes") // NO payload — the bus reaches every staff tab
  return NextResponse.json({ note: data })
}

export async function PATCH(req: NextRequest) {
  const user = await currentStaff()
  if (!user) return fail("Not authorized", 403)

  const p = await req.json().catch(() => ({}))
  const id = typeof p.id === "string" ? p.id : ""
  const action = typeof p.action === "string" ? p.action : ""
  if (!id) return fail("Which note?")

  // Only the author or the current shared-with recipient may touch a note. Load it first.
  const { data: note, error: loadErr } = await notesTable().select(NOTE_COLUMNS).eq("id", id).single()
  if (loadErr || !note) return fail("That note is gone.", 404)
  const mayTouch = note.author_user_id === user.id || note.shared_with_user_id === user.id
  if (!mayTouch) return fail("That isn't your note.", 403)

  let patch: Record<string, unknown> = {}
  let pushTo: { userId: string; noteBody: string } | null = null

  if (action === "edit") {
    const { body, error } = validateNoteBody(p.body)
    if (error || !body) return fail(error ?? "A note needs some text.")
    // stale-edit guard: only write if the row hasn't changed since the client loaded it
    if (typeof p.expectedUpdatedAt === "string") {
      const { data: fresh } = await notesTable().select("updated_at").eq("id", id).single()
      if (fresh && fresh.updated_at !== p.expectedUpdatedAt) {
        return fail("Someone else just edited this note — reopen it to see their change.", 409)
      }
    }
    patch = { body }
  } else if (action === "snooze") {
    const { iso, error } = computeSnoozeUntil(p.preset, new Date(), p.custom)
    if (error || !iso) return fail(error ?? "Pick when to bring it back.")
    // PER PERSON — see setMyNoteState. Snoozing a shared note used to pull it off
    // the other person's screen too, and bring it back at a time they never chose.
    const err = await setMyNoteState(id, user.id, { snoozed_until: iso })
    if (err) return fail(err, 500)
    await emitUiEvent("notes")
    return NextResponse.json({ ok: true })
  } else if (action === "unsnooze") {
    const err = await setMyNoteState(id, user.id, { snoozed_until: null })
    if (err) return fail(err, 500)
    await emitUiEvent("notes")
    return NextResponse.json({ ok: true })
  } else if (action === "share") {
    const targetId = typeof p.shared_with_user_id === "string" ? p.shared_with_user_id : ""
    if (!targetId) return fail("Who do you want to share it with?")
    if (targetId === user.id) return fail("You already have this note.")
    // resolve name + confirm the target is real STAFF (admin/team) — never a partner/client
    const members = (await listTeamMembers()).filter((m) => m.role === "admin" || m.role === "team")
    const target = members.find((m) => m.id === targetId)
    if (!target) return fail("That person isn't a staff member.")
    patch = { visibility: "shared", shared_with_user_id: targetId, shared_with_name: target.name }
    pushTo = { userId: targetId, noteBody: note.body }
  } else if (action === "team") {
    patch = { visibility: "team", shared_with_user_id: null, shared_with_name: null }
  } else if (action === "private") {
    patch = { visibility: "private", shared_with_user_id: null, shared_with_name: null }
  } else if (action === "set_client") {
    // Attach / change / clear the client this note is about. Accepts an account id, a contact
    // id, or neither (clear). Ids are verified to exist so a typo can't orphan the note.
    const accountId = typeof p.account_id === "string" && p.account_id ? p.account_id : null
    const contactId = typeof p.contact_id === "string" && p.contact_id ? p.contact_id : null
    if (accountId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: acct } = await (supabaseAdmin as any)
        .from("accounts").select("id").eq("id", accountId).maybeSingle()
      if (!acct) return fail("That company isn't in the CRM.")
    }
    if (contactId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: c } = await (supabaseAdmin as any)
        .from("contacts").select("id").eq("id", contactId).maybeSingle()
      if (!c) return fail("That person isn't in the CRM.")
    }
    patch = { account_id: accountId, contact_id: contactId }
  } else if (action === "archive") {
    // Done is MINE. Clicking it used to clear the note for everyone it was
    // shared with — Antonio's report, 2026-07-23.
    const err = await setMyNoteState(id, user.id, { archived_at: new Date().toISOString() })
    if (err) return fail(err, 500)
    await emitUiEvent("notes")
    return NextResponse.json({ ok: true })
  } else if (action === "unarchive") {
    const err = await setMyNoteState(id, user.id, { archived_at: null })
    if (err) return fail(err, 500)
    await emitUiEvent("notes")
    return NextResponse.json({ ok: true })
  } else {
    return fail("Unknown action.")
  }

  const { data, error } = await notesTable().update(patch).eq("id", id).select(NOTE_COLUMNS).single()
  if (error) return fail(error.message || "Could not update the note.", 500)

  // Push to the person a note was just handed to — fire-and-forget, never blocks the response.
  if (pushTo) {
    void sendPushToAdminUsers([pushTo.userId], {
      title: `${getUserDisplayName(user)} shared a note`,
      body: pushTo.noteBody.slice(0, 120),
      url: `/`, // opens the CRM dashboard where the shared note floats
      tag: `staff-note-${id}`,
    }).catch(() => {})
  }

  emitUiEvent("notes")
  return NextResponse.json({ note: data })
}
