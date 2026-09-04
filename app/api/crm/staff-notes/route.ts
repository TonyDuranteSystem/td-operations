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
  listMyNotesForUser,
  listActiveNotesForUser,
  listNotesForAccount,
  listNotesForContact,
  validateNoteBody,
  safeOriginPath,
  computeSnoozeUntil,
  mayTouchNote,
  mayEditBody,
  editNotifyTargets,
  shouldSendEditPush,
  repliesTable,
  validateReplyBody,
  replyNotifyTargets,
} from "@/lib/notes/staff-notes"
import { capturesTable } from "@/lib/captures/db"
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
    // scope=members → just me + the shareable staff, no notes. Lets any surface open the
    // full note editor in create mode (it needs the "who's it for" chips) without paying
    // for a feed it won't render.
    if (sp.get("scope") === "members") {
      const members = (await listTeamMembers())
        .filter((m) => (m.role === "admin" || m.role === "team") && m.id !== user.id)
        .map((m) => ({ id: m.id, name: m.name }))
      return NextResponse.json({ me: { id: user.id, name: getUserDisplayName(user) }, members })
    }
    // scope=mine → notes I authored, any state (the Capture/Share "pick one of
    // my own notes" destination picker — deliberately narrower than "all",
    // which also includes notes others shared/teamed to me).
    if (sp.get("scope") === "mine") {
      const res = await listMyNotesForUser(user.id)
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

  // WHO'S IT FOR? — chosen at creation (Antonio, 2026-07-23). Previously every
  // note was born private and had to be shared in a second step from the card.
  // `recipient` is 'me' (default) | 'team' | a staff user id. The shape mirrors
  // the existing share/team/private PATCH actions AND the DB coherence CHECK:
  // 'shared' MUST name a person, the other two MUST NOT.
  const recipient = typeof payload.recipient === "string" ? payload.recipient : "me"
  let visibility: "private" | "shared" | "team" = "private"
  let sharedWithId: string | null = null
  let sharedWithName: string | null = null
  let pushTargetId: string | null = null
  if (recipient === "team") {
    visibility = "team"
  } else if (recipient !== "me") {
    // A specific staff member. Validate the SAME way share does — never a
    // partner/client, never yourself.
    if (recipient === user.id) return fail("That's you — leave it as 'just me'.")
    const members = (await listTeamMembers()).filter((m) => m.role === "admin" || m.role === "team")
    const target = members.find((m) => m.id === recipient)
    if (!target) return fail("That person isn't a staff member.")
    visibility = "shared"
    sharedWithId = target.id
    sharedWithName = target.name
    pushTargetId = target.id
  }

  // Optional come-back date, chosen at creation (full-editor creation, 2026-07-29).
  // Validated the same way a custom snooze is: a real instant, in the future.
  let comeBackIso: string | null = null
  if (payload.come_back != null && payload.come_back !== "") {
    const { iso, error } = computeSnoozeUntil("custom", new Date(), String(payload.come_back))
    if (error || !iso) return fail(error ?? "That come-back date didn't make sense.")
    comeBackIso = iso
  }
  // The date as the CREATOR saw it, for the push text only — the server can't render the
  // user's timezone, so the client sends the words it showed. Plain text, hard-capped.
  const comeBackDisplay =
    typeof payload.come_back_display === "string"
      ? payload.come_back_display.replace(/[\r\n]+/g, " ").trim().slice(0, 60)
      : ""

  const insert = {
    body,
    color,
    author_user_id: user.id,
    author_name: getUserDisplayName(user),
    visibility,
    shared_with_user_id: sharedWithId,
    shared_with_name: sharedWithName,
    account_id: typeof payload.account_id === "string" ? payload.account_id : null,
    contact_id: typeof payload.contact_id === "string" ? payload.contact_id : null,
    origin_url: origin,
  }

  const { data, error } = await notesTable().insert(insert).select(NOTE_COLUMNS).single()
  if (error) return fail(error.message || "Could not save the note.", 500)

  // A come-back date set at creation applies to EVERY initial viewer (per-person snooze
  // rows) — a note made "for Luca, back Monday" must not float on Luca's screen today.
  // Written BEFORE the realtime emit so no tab can render the note un-snoozed first.
  let warning: string | null = null
  if (comeBackIso) {
    const viewerIds =
      visibility === "team"
        ? (await listTeamMembers()).filter((m) => m.role === "admin" || m.role === "team").map((m) => m.id)
        : visibility === "shared" && sharedWithId
          ? [user.id, sharedWithId]
          : [user.id]
    const rows = Array.from(new Set(viewerIds)).map((uid) => ({
      note_id: data.id,
      user_id: uid,
      snoozed_until: comeBackIso,
      updated_at: new Date().toISOString(),
    }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: stateErr } = await (supabaseAdmin as any)
      .from("staff_note_state")
      .upsert(rows, { onConflict: "note_id,user_id" })
    if (stateErr) {
      // The note EXISTS but is undated — say so plainly instead of pretending success.
      warning = "The note was saved, but the come-back date could not be set. Open the note and set the date again."
    }
  }

  // Tell the recipient, same push the share action sends. Best-effort.
  // Deep-links to the exact note (the Notes page opens it), never just the dashboard.
  if (pushTargetId) {
    const dateSuffix = comeBackIso && !warning ? ` (comes back ${comeBackDisplay || "later"})` : ""
    void sendPushToAdminUsers([pushTargetId], {
      title: `${getUserDisplayName(user)} shared a note`,
      body: `${body.slice(0, 120)}${dateSuffix}`,
      url: `/notes?note=${data.id}`,
      tag: `staff-note-${data.id}`,
    }).catch(() => {})
  }

  emitUiEvent("notes") // NO payload — the bus reaches every staff tab
  return NextResponse.json({ note: data, ...(warning ? { warning } : {}) })
}

export async function PATCH(req: NextRequest) {
  const user = await currentStaff()
  if (!user) return fail("Not authorized", 403)

  const p = await req.json().catch(() => ({}))
  const id = typeof p.id === "string" ? p.id : ""
  const action = typeof p.action === "string" ? p.action : ""
  if (!id) return fail("Which note?")

  // Everyone the note REACHES may touch it (edit / done / snooze) — author, shared-with,
  // or any staff member on a team note. The old inline guard forgot team notes entirely
  // (they carry no shared_with by design), locking every non-author out of Done/snooze.
  const { data: note, error: loadErr } = await notesTable().select(NOTE_COLUMNS).eq("id", id).single()
  if (loadErr || !note) return fail("That note is gone.", 404)
  if (!mayTouchNote(note, user.id)) return fail("That isn't your note.", 403)

  // Changing WHO SEES a note is the AUTHOR's call alone. This is the guard that was
  // missing on 2026-07-28: Luca "shared back" a note to its author, which overwrote the
  // one shared-with slot (him) and made the note vanish from his own screens.
  const changesVisibility = action === "share" || action === "team" || action === "private"
  if (changesVisibility && note.author_user_id !== user.id) {
    return fail(
      `Only ${note.author_name || "the person who wrote this note"} can change who sees it. ` +
        "To answer, write in the Reply box — they'll be notified.",
      403,
    )
  }

  // REPLY — its own branch, not the shared update tail (there is no note-row patch).
  // A reply never touches the parent's updated_at (council 2026-07-29: bumping gave the
  // author a false edit-conflict on their own next Save and muted the edit push's guard).
  if (action === "reply") {
    const { body, error } = validateReplyBody(p.body)
    if (error || !body) return fail(error ?? "A reply needs some text.")
    const { error: insErr } = await repliesTable().insert({
      note_id: id,
      author_user_id: user.id,
      author_name: getUserDisplayName(user),
      body,
    })
    if (insErr) {
      // Most likely race: the author hard-deleted the note while this reply was typed.
      // The FK insert fails — say the note is gone, never pretend the reply landed.
      const code = (insErr as { code?: string }).code
      if (code === "23503") return fail("That note was just deleted — your reply has nowhere to go.", 404)
      return fail(insErr.message || "Could not send the reply.", 500)
    }

    // Push ONLY after the checked insert — everyone the note reaches except the
    // replier, minus anyone the note is snoozed away from (their come-back date
    // exists to shield them; they catch up when it returns).
    const staffIds = (await listTeamMembers())
      .filter((m) => m.role === "admin" || m.role === "team")
      .map((m) => m.id)
    const targets = replyNotifyTargets(note, user.id, staffIds, new Date())
    if (targets.length > 0) {
      void sendPushToAdminUsers(targets, {
        title: `${getUserDisplayName(user)} replied to a note`,
        body: body.slice(0, 120),
        url: `/notes?note=${id}`,
        tag: `staff-note-${id}`,
      }).catch(() => {})
    }

    emitUiEvent("notes")
    // Return the fresh row (replies embedded) so the editor can show the thread at once.
    const { data: freshNote } = await notesTable().select(NOTE_COLUMNS).eq("id", id).single()
    return NextResponse.json({ note: freshNote ?? note })
  }

  // ATTACH A CAPTURE — its own branch, same shape as reply: no generic patch
  // tail. Attaching is treated exactly like editing the note's own text — the
  // AUTHOR alone, via the identical mayEditBody gate (Antonio, 2026-09-04:
  // "same rule that already governs editing a note's text").
  if (action === "attach_capture") {
    if (!mayEditBody(note, user.id)) {
      return fail(
        `Only ${note.author_name || "the author"} can attach something to this note. ` +
          "Write your answer in the Reply box instead.",
        403,
      )
    }
    const captureId = typeof p.capture_id === "string" ? p.capture_id : ""
    if (!captureId) return fail("Which picture?")

    const { data: capture, error: captureErr } = await capturesTable()
      .select("id, image_url, image_name, mime_type, size_bytes, captured_by_user_id")
      .eq("id", captureId)
      .single()
    if (captureErr || !capture) return fail("That capture is gone. Please try again.", 404)
    // Defense in depth: the id only ever comes from this same user's own
    // just-completed capture flow, but never trust a client-supplied id blindly.
    if (capture.captured_by_user_id !== user.id) return fail("That isn't your capture.", 403)

    const { error: attachErr } = await notesTable()
      .update({
        attachment_url: capture.image_url,
        attachment_name: capture.image_name,
        attachment_mime_type: capture.mime_type,
        attachment_size_bytes: capture.size_bytes,
      })
      .eq("id", id)
    if (attachErr) return fail(attachErr.message || "Could not attach the picture.", 500)

    // Best-effort — the note attach above is the write that actually matters;
    // if this one fails, only the capture folder's "where it went" label goes
    // stale, the note attachment itself is already saved and correct.
    await capturesTable()
      .update({ destination: { type: "sticky_note", id, label: note.body.slice(0, 60) } })
      .eq("id", captureId)

    emitUiEvent("notes")
    const { data: freshNote } = await notesTable().select(NOTE_COLUMNS).eq("id", id).single()
    return NextResponse.json({ note: freshNote ?? note })
  }

  let patch: Record<string, unknown> = {}
  let pushTo: { userId: string; noteBody: string } | null = null
  let editedBody: string | null = null

  if (action === "edit") {
    // The note's TEXT is the author's alone — everyone else answers in replies.
    // Server-enforced: a stale tab from before this rule must not rewrite it.
    if (!mayEditBody(note, user.id)) {
      return fail(
        `Only ${note.author_name || "the author"} can change the note's text. ` +
          "Write your answer in the Reply box instead.",
        403,
      )
    }
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
    editedBody = body
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
  // Deep-links to the exact note: the Notes page opens it, whatever state it's in there.
  if (pushTo) {
    void sendPushToAdminUsers([pushTo.userId], {
      title: `${getUserDisplayName(user)} shared a note`,
      body: pushTo.noteBody.slice(0, 120),
      url: `/notes?note=${id}`,
      tag: `staff-note-${id}`,
    }).catch(() => {})
  }

  // An EDITED shared/team note tells the other person — this is how a reply typed into a
  // note reaches its author (the missing signal in the 2026-07-28 incident: Luca answered,
  // Antonio was never told). Rules:
  //  - suppressed when the editor asked (`suppress_notify`): the editor's auto-save right
  //    before "Only me" must not broadcast the new text to the person being removed;
  //  - burst-guarded: rapid consecutive saves buzz once, but the FIRST change after
  //    creation always pushes (shouldSendEditPush reads the PRE-edit timestamps);
  //  - fans out to everyone the note reaches except the editor (team → all staff).
  if (editedBody && p.suppress_notify !== true && shouldSendEditPush(note, new Date())) {
    const staffIds = (await listTeamMembers())
      .filter((m) => m.role === "admin" || m.role === "team")
      .map((m) => m.id)
    const targets = editNotifyTargets(note, user.id, staffIds)
    if (targets.length > 0) {
      void sendPushToAdminUsers(targets, {
        title: `${getUserDisplayName(user)} updated a note`,
        body: editedBody.slice(0, 120),
        url: `/notes?note=${id}`,
        tag: `staff-note-${id}`,
      }).catch(() => {})
    }
  }

  emitUiEvent("notes")
  return NextResponse.json({ note: data })
}

/**
 * DELETE /api/crm/staff-notes?id=<uuid> — remove a note COMPLETELY, for everyone.
 *
 * Distinct from "Done", which is a per-person soft archive (staff_note_state).
 * This is a real hard delete: the note is gone for the author and anyone it was
 * shared with. AUTHOR-ONLY — a recipient can clear it from their own screen with
 * Done, but destroying it for both people is the author's call.
 *
 * Hard delete is correct here and does NOT violate R100 (soft-delete for
 * CLIENT-visible content): staff_notes is internal-only (RLS deny-all, a client
 * can never reach it) with no FK chain to client-visible state, which R100
 * explicitly permits to hard-delete. The per-person state rows cascade
 * (staff_note_state ON DELETE CASCADE). Any chat conversation opened from the
 * note is NOT linked to it and is deliberately left untouched (Antonio,
 * 2026-07-23: "just delete the note; leave the chat alone").
 */
export async function DELETE(req: NextRequest) {
  const user = await currentStaff()
  if (!user) return fail("Not authorized", 403)

  const id = req.nextUrl.searchParams.get("id") ?? ""
  if (!id) return fail("Which note?")

  const { data: note } = await notesTable().select("author_user_id").eq("id", id).single()
  if (!note) return fail("That note no longer exists.", 404)
  if (note.author_user_id !== user.id) {
    return fail("Only the person who wrote a note can delete it. Use Done to clear it from your screen.", 403)
  }

  const { error } = await notesTable().delete().eq("id", id)
  if (error) return fail(error.message || "Could not delete the note.", 500)

  emitUiEvent("notes")
  return NextResponse.json({ ok: true })
}
