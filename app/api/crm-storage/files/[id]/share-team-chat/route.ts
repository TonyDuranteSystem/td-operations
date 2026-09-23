import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStaffUser } from "@/lib/auth"
import { CRM_STORAGE_BUCKET } from "@/lib/crm-storage/constants"
import { CHAT_SHARE_MAX_BYTES, CHAT_SHARE_MAX_MB } from "@/lib/crm-storage/share-limits"
import { validateChatAttachment } from "@/lib/portal/chat-attachment"
import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"

/** A duplicate send within this window is almost certainly a double-click or
 *  a second browser tab, not a deliberate resend — see the header comment on
 *  lib/crm-storage/share-actions.ts for why this route has no permanent
 *  "already shared" claim (a stored document is legitimately resendable,
 *  unlike a one-shot capture), and why a short window guard is still needed
 *  on top of that: bug-hunter, 2026-09-23 — the client-side `disabled={busy}`
 *  button guard protects nothing across two tabs or two closely-spaced
 *  clicks, and the slow copy-then-send round trip (download + re-upload +
 *  deliver) gives a real multi-second window for exactly that. */
const DUPLICATE_SEND_WINDOW_SECONDS = 15

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/**
 * POST /api/crm-storage/files/[id]/share-team-chat
 *
 * Sends an existing CRM Storage file into a Team Chat thread as a real
 * attachment. Modeled on the proven app/api/captures/[id]/share-team-chat
 * route (same copy-then-deliver-through-the-real-send-route shape, same
 * reason for NOT using lib/team/post-message.ts's postTeamMessage() — that
 * always stamps the CLAUDE sentinel identity, and a person sharing their own
 * file must show up as themselves). See lib/crm-storage/share-actions.ts for
 * why this route has no "already shared" claim/resend concept: a stored
 * document is a reusable library item, not a one-shot capture.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isStaffUser(user)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 })
  }
  const { id: fileId } = await params

  const body = await request.json().catch(() => ({}))
  const threadId = typeof body.thread_id === "string" ? body.thread_id : ""
  if (!threadId) return NextResponse.json({ error: "Which conversation?" }, { status: 400 })

  const { data: file, error: fileErr } = await db
    .from("crm_storage_files")
    .select("id, file_name, mime_type, file_size, storage_bucket, storage_path")
    .eq("id", fileId)
    .is("deleted_at", null)
    .maybeSingle()
  if (fileErr || !file) return NextResponse.json({ error: "That file is gone. Please try again." }, { status: 404 })
  // Fail CLOSED on an unverifiable size, not open — a null/invalid file_size
  // must never silently skip the cap (bug-hunter, 2026-09-23: reachable only
  // via a direct API call today, since the shipped UI always sends a real
  // size, but the server must not rely on that holding forever).
  if (file.file_size == null || Number.isNaN(Number(file.file_size))) {
    return NextResponse.json({ error: "This file's size couldn't be verified. Please try again." }, { status: 400 })
  }
  if (Number(file.file_size) > CHAT_SHARE_MAX_BYTES) {
    return NextResponse.json({ error: `That file is too large for chat. Maximum: ${CHAT_SHARE_MAX_MB} MB.` }, { status: 400 })
  }
  // CRM Storage's own upload path has no file-type gate (unlike this exact
  // destination's own direct-upload path, which blocks active-content types
  // "because attachments live on a PUBLIC bucket URL" — lib/portal/chat-
  // attachment.ts). Without this check a stored file could carry an active-
  // content type straight into a public, permanent chat-attachment URL,
  // which this route's own copy step below would otherwise wave through
  // untouched (security review, 2026-09-23).
  const attachmentError = validateChatAttachment(file.file_name, Number(file.file_size), file.mime_type || "")
  if (attachmentError) return NextResponse.json({ error: attachmentError }, { status: 400 })

  const { data: thread } = await db.from("internal_threads").select("id").eq("id", threadId).single()
  if (!thread) return NextResponse.json({ error: "That conversation is gone. Please try again." }, { status: 404 })

  // Duplicate-send guard, part 1 — catches "sent a few seconds ago, in an
  // earlier request that already finished." See DUPLICATE_SEND_WINDOW_SECONDS.
  const recentCutoff = new Date(Date.now() - DUPLICATE_SEND_WINDOW_SECONDS * 1000).toISOString()
  const { data: recentMessages } = await db
    .from("internal_messages")
    .select("attachments")
    .eq("thread_id", threadId)
    .gte("created_at", recentCutoff)
    .order("created_at", { ascending: false })
    .limit(20)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const alreadySentJustNow = (recentMessages || []).some((m: any) =>
    Array.isArray(m.attachments) && m.attachments.some((a: any) => a?.name === file.file_name),
  )
  if (alreadySentJustNow) {
    return NextResponse.json({ error: "This was just sent to that conversation — check before sending again." }, { status: 429 })
  }

  // Duplicate-send guard, part 2 — a real atomic claim for the case the
  // check above cannot catch: two requests genuinely in flight at once (a
  // double-click, or the same file open in two tabs), both passing the
  // SELECT above before either has written a message row. The multi-second
  // copy-then-send round trip below gives that race a real window (AI
  // Architect + Bug-Hunter, 2026-09-23, independently). `upsert` with
  // `ignoreDuplicates` is the supabase-js idiom for INSERT ... ON CONFLICT
  // DO NOTHING — an empty `data` means someone else already holds the claim.
  const lockTarget = `team_chat:${threadId}`
  const { data: claimed } = await db
    .from("crm_storage_send_locks")
    .upsert({ file_id: fileId, target: lockTarget }, { onConflict: "file_id,target", ignoreDuplicates: true })
    .select()
  if (!claimed || claimed.length === 0) {
    return NextResponse.json({ error: "This is already being sent to that conversation — check before sending again." }, { status: 429 })
  }

  try {
    // Copy: download from the private crm-files bucket, upload into the
    // public `assets` bucket team chat already uses — same shape as the
    // captures route's own cross-bucket copy.
    const { data: blob, error: dlErr } = await db.storage.from(file.storage_bucket || CRM_STORAGE_BUCKET).download(file.storage_path)
    if (dlErr || !blob) {
      console.error("[crm-storage/share-team-chat] download error:", dlErr)
      return NextResponse.json({ error: "Could not read the file. Please try again." }, { status: 500 })
    }
    const buffer = Buffer.from(await blob.arrayBuffer())
    const ext = (file.file_name?.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin"
    const assetsPath = `team-chat/${threadId}/${randomUUID()}.${ext}`
    const { error: upErr } = await db.storage
      .from("assets")
      .upload(assetsPath, buffer, { contentType: file.mime_type || "application/octet-stream", upsert: false })
    if (upErr) {
      console.error("[crm-storage/share-team-chat] upload error:", upErr)
      return NextResponse.json({ error: "Could not share the file. Please try again." }, { status: 500 })
    }
    const { data: urlData } = db.storage.from("assets").getPublicUrl(assetsPath)

    // Deliver through the real human send route — same identity, push, and
    // mention handling every other team-chat message already gets.
    let sendRes: Response
    try {
      sendRes = await fetch(`${request.nextUrl.origin}/api/team/threads/${threadId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: request.headers.get("cookie") || "" },
        body: JSON.stringify({
          message: `Shared a file: ${file.file_name}`,
          attachments: [
            {
              url: urlData.publicUrl,
              name: file.file_name,
              mime_type: file.mime_type || "application/octet-stream",
              size: file.file_size != null ? Number(file.file_size) : undefined,
            },
          ],
        }),
      })
    } catch (err) {
      console.error("[crm-storage/share-team-chat] send route unreachable:", err)
      return NextResponse.json({ error: "Could not reach team chat. Please try again." }, { status: 500 })
    }
    if (!sendRes.ok) {
      const d = await sendRes.json().catch(() => ({}))
      return NextResponse.json({ error: d.error || "Could not send to team chat." }, { status: sendRes.status })
    }
    const sendData = await sendRes.json().catch(() => ({}))

    return NextResponse.json({ ok: true, message_id: sendData.message?.id ?? null })
  } finally {
    // Release the claim whether this send succeeded or failed — a real
    // later resend (or a retry after a failure) must never be permanently
    // blocked, only a genuinely concurrent duplicate.
    await db.from("crm_storage_send_locks").delete().eq("file_id", fileId).eq("target", lockTarget)
  }
}
