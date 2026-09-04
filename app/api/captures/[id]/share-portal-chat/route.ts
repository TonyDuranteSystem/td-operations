import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStaffUser } from "@/lib/auth"
import { capturesTable } from "@/lib/captures/db"
import { WORKER_UPLOAD_BUCKET } from "@/lib/captures/storage"
import { PORTAL_BASE_URL } from "@/lib/config"
import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"

/**
 * POST /api/captures/[id]/share-portal-chat
 *
 * Sends an already-uploaded capture into a real client's portal chat — the
 * one client-facing Capture destination (Phase 2, council-reviewed
 * 2026-09-04). Modeled directly on the already-shipped
 * app/api/captures/[id]/share-team-chat/route.ts, with two deliberate
 * differences driven by that review:
 *
 * 1. VALIDATES THE SEND LOCALLY BEFORE COPYING ANY BYTES. The team-chat
 *    route's own order (validate the thread exists, THEN copy) is the
 *    correct precedent; an earlier draft of this route inverted it, which a
 *    bug-hunter pass flagged: if the copy runs first and the send is then
 *    correctly rejected downstream, the client's screenshot is already
 *    sitting at a live public URL with no cleanup path. So this route checks
 *    the contact/account/link/status itself, up front, and never touches
 *    Storage on a request it's going to reject anyway.
 *
 * 2. DOES NOT HAND OUT A PERMANENT PUBLIC LINK. The bytes still have to land
 *    in the public `assets` bucket (same one every portal-chat attachment —
 *    staff or client-uploaded — already uses; not a new trust boundary), but
 *    under the SAME `chat-attachments/<accountId|contactId>/<file>` path
 *    convention the existing access-controlled proxy
 *    (app/api/portal/chat/attachment/route.ts) already serves. So the stored
 *    attachment_url points at that proxy, not at storage.getPublicUrl() — a
 *    leaked/forwarded link on its own is not enough to view the picture,
 *    because the proxy still checks, on every single view, that the
 *    requester is either staff or the specific client this was sent to. This
 *    is the exact same "only the right person can view this" check already
 *    used by /api/captures/[id]/image for a staff member's own capture
 *    history, now reused for the client-facing case.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isStaffUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const captureId = params.id
  const body = await request.json().catch(() => ({}))
  const contactId = typeof body.contact_id === "string" ? body.contact_id : ""
  const accountId = typeof body.account_id === "string" && body.account_id ? body.account_id : null
  if (!contactId) return NextResponse.json({ error: "Who is this going to?" }, { status: 400 })

  const { data: capture, error: captureErr } = await capturesTable()
    .select("id, image_url, image_name, mime_type, size_bytes, note, title, captured_by_user_id")
    .eq("id", captureId)
    .single()
  if (captureErr || !capture) return NextResponse.json({ error: "That capture is gone. Please try again." }, { status: 404 })
  if (capture.captured_by_user_id !== user.id) {
    return NextResponse.json({ error: "That isn't your capture." }, { status: 403 })
  }

  // Validate the send BEFORE touching Storage — see header comment.
  const { data: contact } = await supabaseAdmin
    .from("contacts")
    .select("email, portal_email_sent_at")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact?.email || !contact.portal_email_sent_at) {
    return NextResponse.json({ error: "This person doesn't have portal access yet. Please try again." }, { status: 400 })
  }
  if (accountId) {
    const { data: link } = await supabaseAdmin
      .from("account_contacts")
      .select("contact_id")
      .eq("account_id", accountId)
      .eq("contact_id", contactId)
      .maybeSingle()
    if (!link) {
      return NextResponse.json({ error: "That company doesn't belong to this person anymore. Please search again." }, { status: 400 })
    }
    const { data: account } = await supabaseAdmin.from("accounts").select("status, company_name").eq("id", accountId).maybeSingle()
    if (!account || (account.status !== "Active" && account.status !== "Suspended")) {
      return NextResponse.json({ error: "That company's account is closed — nothing was sent." }, { status: 400 })
    }
  }

  // Copy: download from the private bucket, upload into the SAME public
  // bucket + path convention the existing proxy route already expects.
  const { data: blob, error: dlErr } = await supabaseAdmin.storage.from(WORKER_UPLOAD_BUCKET).download(capture.image_url)
  if (dlErr || !blob) {
    console.error("[captures/share-portal-chat] download error:", dlErr)
    return NextResponse.json({ error: "Could not read the picture. Please try again." }, { status: 500 })
  }
  const buffer = Buffer.from(await blob.arrayBuffer())
  const ext = (capture.image_name?.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "png"
  const dir = accountId ?? contactId
  const objectPath = `chat-attachments/${dir}/${randomUUID()}.${ext}`
  const { error: upErr } = await supabaseAdmin.storage
    .from("assets")
    .upload(objectPath, buffer, { contentType: capture.mime_type || "image/png", upsert: false })
  if (upErr) {
    console.error("[captures/share-portal-chat] upload error:", upErr)
    return NextResponse.json({ error: "Could not share the picture. Please try again." }, { status: 500 })
  }
  const attachmentUrl = `${PORTAL_BASE_URL}/api/portal/chat/attachment?path=${encodeURIComponent(objectPath)}`

  // Deliver through the real staff send route — same identity, same
  // send-scope invariant, same client notifications, same audit log every
  // other staff portal-chat reply already gets.
  const message = (capture.note?.trim() || capture.title || "Shared a screenshot").slice(0, 5000)
  let sendRes: Response
  try {
    sendRes = await fetch(`${request.nextUrl.origin}/api/portal/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: request.headers.get("cookie") || "" },
      body: JSON.stringify({
        contact_id: contactId,
        account_id: accountId || undefined,
        sender_context: accountId ? "company" : "person",
        message,
        attachment_url: attachmentUrl,
        attachment_name: capture.image_name || "screenshot.png",
      }),
    })
  } catch (err) {
    console.error("[captures/share-portal-chat] send route unreachable:", err)
    return NextResponse.json({ error: "Could not reach the client's chat. Please try again." }, { status: 500 })
  }
  if (!sendRes.ok) {
    const d = await sendRes.json().catch(() => ({}))
    return NextResponse.json({ error: d.error || "Could not send to the client." }, { status: sendRes.status })
  }
  const sendData = await sendRes.json().catch(() => ({}))

  // Best-effort — the message above is what actually matters; a failure here
  // only leaves the capture folder's "where it went" label stale.
  await capturesTable()
    .update({ destination: { type: "portal_chat", id: contactId, account_id: accountId, label: message.slice(0, 60) } })
    .eq("id", captureId)

  // Instant alert: every send through this new, client-facing path pings
  // staff immediately (project-director review, 2026-09-04) — even a caught
  // mistake can't recall the push/email the send route just fired, so the
  // goal is catching a wrong-target send in minutes, not the two months the
  // 2026-08-07 leak took to surface. Best-effort; never blocks the send.
  try {
    const { sendPushToStaff } = await import("@/lib/team/notify")
    await sendPushToStaff({
      title: "Screenshot sent to client",
      body: `${user.email ?? "Someone"} shared a screenshot in the portal chat.`,
      url: accountId ? `/portal-chats?account=${accountId}` : `/portal-chats?contact=${contactId}`,
      tag: `capture-portal-chat-${captureId}`,
    })
  } catch {
    // never block the send on an alert failure
  }

  return NextResponse.json({ ok: true, message_id: sendData.message?.id ?? null })
}
