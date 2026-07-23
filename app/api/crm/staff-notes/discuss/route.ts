import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser, getUserDisplayName } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { NOTE_COLUMNS, isNoteVisibleTo } from "@/lib/notes/staff-notes"
import { findOrCreateConversation } from "@/lib/team/find-conversation"
import { parseClientRef } from "@/lib/team/conversations"
import { findOrCreateDm } from "@/lib/team/dm"
import { getSupportPersonUserId } from "@/lib/settings"
import { listTeamMembers } from "@/lib/team/directory"

export const dynamic = "force-dynamic"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function notesTable() { return (supabaseAdmin as any).from("staff_notes") }

/**
 * POST /api/crm/staff-notes/discuss  { note_id }
 *
 * "Discuss this note" — resolve WHERE the conversation about this note lives,
 * find-or-create it, and hand the caller a thread id (+ a draft opening line).
 * The note card then opens the floating chat on that thread. Nothing is sent
 * here — the draft is pre-filled into the composer so the human sends or edits.
 *
 * TWO CASES (Antonio's model, 2026-07-23):
 *  - note about a CLIENT  → that client's conversation (PER-CLIENT, not per-note:
 *    every note about the same client opens the one place their talk lives).
 *  - note with NO client  → the direct chat with the teammate (the note's
 *    shared-with person if it has one, else the configured support person, else
 *    the one other staff member).
 *
 * Staff-only, and you must be able to SEE the note (author / shared-with / team).
 */
export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const noteId = typeof body.note_id === "string" ? body.note_id : ""
  if (!noteId) return NextResponse.json({ error: "Which note?" }, { status: 400 })

  const { data: note } = await notesTable().select(NOTE_COLUMNS).eq("id", noteId).single()
  if (!note) return NextResponse.json({ error: "That note no longer exists." }, { status: 404 })
  if (!isNoteVisibleTo(note, user.id)) {
    return NextResponse.json({ error: "That note isn't yours to open." }, { status: 403 })
  }

  const excerpt = String(note.body ?? "").replace(/\s+/g, " ").trim().slice(0, 140)
  const draft = excerpt ? `About this note: "${excerpt}"` : undefined

  // ── CLIENT case ────────────────────────────────────────────────────────────
  const clientRef = note.account_id
    ? parseClientRef(`account:${note.account_id}`)
    : note.contact_id
      ? parseClientRef(`contact:${note.contact_id}`)
      : null

  if (clientRef) {
    // topic omitted → the client's MAIN conversation (per-client, deliberately
    // not per-note — see the header). findOrCreateConversation seeds the other
    // staff as participants and notifies them.
    const found = await findOrCreateConversation({
      ref: clientRef,
      topic: null,
      createdBy: user.id,
      createdByName: getUserDisplayName(user),
    })
    if ("error" in found) {
      return NextResponse.json({ error: found.error }, { status: found.status })
    }
    return NextResponse.json({ threadId: found.thread.id, draft })
  }

  // ── NO-CLIENT case → a direct chat with the teammate ────────────────────────
  const otherId = await resolveTeammate(user.id, note.shared_with_user_id)
  if (!otherId) {
    return NextResponse.json(
      { error: "Attach a client, or share this note with a teammate, to discuss it." },
      { status: 400 },
    )
  }
  const { thread } = await findOrCreateDm(user.id, otherId)
  return NextResponse.json({ threadId: thread.id, draft })
}

/**
 * Who do I open a direct chat with for a client-less note?
 *  1. the person the note is shared with, if any;
 *  2. else the configured support person (seeded to Luca);
 *  3. else, if there's exactly one other staff member, them;
 *  4. else null — ambiguous, ask the user to share it or attach a client.
 * Never returns the caller.
 */
async function resolveTeammate(meId: string, sharedWithId: unknown): Promise<string | null> {
  if (typeof sharedWithId === "string" && sharedWithId && sharedWithId !== meId) {
    return sharedWithId
  }
  const support = await getSupportPersonUserId().catch(() => null)
  if (support && support !== meId) return support
  const others = (await listTeamMembers()).filter((m) => m.id !== meId)
  return others.length === 1 ? others[0].id : null
}
