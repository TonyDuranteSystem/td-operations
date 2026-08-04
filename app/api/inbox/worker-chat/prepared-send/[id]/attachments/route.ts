/**
 * POST /api/inbox/worker-chat/prepared-send/<id>/attachments
 *
 * Add or remove a file on a draft that is waiting for Confirm — the staff
 * member's own draft, their own edit. Body: { action: "add", path, name,
 * mime_type?, size? } or { action: "remove", index }.
 *
 * The rules live in `lib/inbox/prepared-attachment-edit.ts` so they can be
 * tested; this route is the plumbing around them: authenticate, read the row,
 * apply, write back, and keep the Team Chat card in step.
 */
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser } from "@/lib/auth"
import { WORKER_UPLOAD_BUCKET } from "@/lib/ai-agent/attachment-reader"
import { discardCopies } from "@/lib/inbox/sendable-attachment"
import {
  addAttachment,
  checkEditable,
  removeAttachment,
  type FrozenAttachment,
} from "@/lib/inbox/prepared-attachment-edit"
import { listTeamMembers } from "@/lib/team/directory"

/**
 * Keep the Team Chat card honest.
 *
 * Unlike the panels — whose card is rebuilt from the row on every render — the
 * Team Chat card is a PERMANENT chat message with the file list baked into it.
 * Adding a file without this leaves the card showing fewer files than the email
 * actually carries, which is the precise failure this whole feature spent a day
 * removing. Best-effort: a failure here must not fail the edit, but it is
 * logged, and the panels are unaffected either way.
 */
async function syncTeamChatCard(preparedId: string, attachments: FrozenAttachment[]): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any
    const { data: rows } = await db
      .from("internal_messages")
      .select("id, card")
      .eq("card->>entity_id", preparedId)
      .is("deleted_at", null)
    for (const row of (rows ?? []) as Array<{ id: string; card: Record<string, unknown> }>) {
      const files = attachments.map((a) => ({
        name: a.name || "file",
        size: a.size,
        content_type: a.content_type,
        origin: a.origin,
        warning: a.warning,
      }))
      await db
        .from("internal_messages")
        .update({ card: { ...row.card, ...(files.length ? { files } : { files: [] }) } })
        .eq("id", row.id)
    }
  } catch (err) {
    console.warn("[prepared-send/attachments] could not sync the Team Chat card:", err)
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: string
    path?: string
    name?: string
    mime_type?: string
    size?: number
    index?: number
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: row, error } = await db
    .from("worker_prepared_sends")
    .select("id, kind, status, actor, attachments")
    .eq("id", params.id)
    .maybeSingle()
  if (error || !row) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 })
  }

  // EVERY identity this person answers to. The panels record the owner by
  // EMAIL; Team Chat records the sender's DISPLAY NAME — so an email-only
  // comparison locks someone out of their own card on exactly the screen this
  // was built for. The team directory is the one definition of a staff member's
  // display name, so it is asked rather than guessed.
  const identities: Array<string | null | undefined> = [user.email]
  try {
    const me = (await listTeamMembers()).find((m) => m.id === user.id || m.email === user.email)
    if (me?.name) identities.push(me.name)
  } catch (err) {
    // Degrades to email-only, which refuses rather than lets someone in.
    console.warn("[prepared-send/attachments] team directory lookup failed:", err)
  }
  const gate = checkEditable({ status: row.status, actor: row.actor, kind: row.kind }, identities)
  if (gate.ok === false) {
    return NextResponse.json({ error: gate.reason }, { status: gate.status })
  }

  const current = (row.attachments ?? []) as FrozenAttachment[]
  const result =
    body.action === "remove"
      ? removeAttachment(current, Number(body.index))
      : addAttachment(current, {
          path: String(body.path ?? ""),
          name: String(body.name ?? "file"),
          content_type: typeof body.mime_type === "string" ? body.mime_type : undefined,
          size: typeof body.size === "number" ? body.size : undefined,
        })
  if (result.ok === false) {
    return NextResponse.json({ error: result.reason }, { status: result.status })
  }

  // Write back ONLY while it is still pending — a confirm racing this edit must
  // win, or a file could be added to an email that has already gone.
  const { data: updated } = await db
    .from("worker_prepared_sends")
    .update({ attachments: result.attachments })
    .eq("id", params.id)
    .eq("status", "pending")
    .select("id")
  if (!updated?.length) {
    return NextResponse.json(
      { error: "This draft was sent or cancelled while you were editing it — nothing was changed." },
      { status: 409 },
    )
  }

  // A removed file we had copied for this draft is now unreachable — drop it.
  // A panel upload (copied false) is the staff member's own object and stays.
  if (result.removed) await discardCopies([result.removed])
  await syncTeamChatCard(params.id, result.attachments)

  // Hand back what the card should now show — never trust the client to guess.
  return NextResponse.json({
    ok: true,
    attachments: result.attachments.map((a) => ({
      name: a.name,
      size: a.size,
      content_type: a.content_type,
      origin: a.origin,
      warning: a.warning,
    })),
  })
}

/** Where the browser uploads a card-added file before attaching it. Staff-only. */
export async function PUT(req: NextRequest) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }
  const body = (await req.json().catch(() => ({}))) as { file_name?: string; file_size?: number; mime_type?: string }
  const fileName = typeof body.file_name === "string" ? body.file_name : null
  if (!fileName) return NextResponse.json({ error: "file_name required" }, { status: 400 })

  const { validateChatAttachment } = await import("@/lib/portal/chat-attachment")
  const { MAX_ATTACHMENT_BYTES } = await import("@/lib/ai-agent/attachment-reader")
  const invalid = validateChatAttachment(fileName, body.file_size ?? 0, body.mime_type ?? "")
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })
  if ((body.file_size ?? 0) > MAX_ATTACHMENT_BYTES) {
    return NextResponse.json(
      { error: `Too large: ${((body.file_size ?? 0) / 1024 / 1024).toFixed(1)} MB (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB).` },
      { status: 400 },
    )
  }

  const { randomUUID } = await import("crypto")
  const ext = (fileName.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin"
  // The SAME path shape the private bucket accepts everywhere else — the client
  // never chooses it, and it is re-validated when the file is attached.
  const path = `worker-chat/${randomUUID()}.${ext}`
  const { data, error } = await supabaseAdmin.storage.from(WORKER_UPLOAD_BUCKET).createSignedUploadUrl(path)
  if (error || !data) {
    console.error("[prepared-send/attachments] signed-URL error:", error)
    return NextResponse.json({ error: "Could not start the upload. Please try again." }, { status: 500 })
  }
  return NextResponse.json({ signedUrl: data.signedUrl, token: data.token, path })
}
