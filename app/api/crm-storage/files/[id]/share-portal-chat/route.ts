import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStaffUser } from "@/lib/auth"
import { CRM_STORAGE_BUCKET } from "@/lib/crm-storage/constants"
import { CHAT_SHARE_MAX_BYTES, CHAT_SHARE_MAX_MB } from "@/lib/crm-storage/share-limits"
import { ACTIVE_ACCOUNT_STATUSES } from "@/lib/captures/portal-destinations"
import { PORTAL_BASE_URL } from "@/lib/config"
import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"

/** See the identical comment in share-team-chat/route.ts — the reasoning is
 *  the same, but this window matters MORE here: this is the one CLIENT-
 *  FACING destination, so a double-send here means a real client sees the
 *  same document twice, not just a teammate. Bug-hunter, 2026-09-23. */
const DUPLICATE_SEND_WINDOW_SECONDS = 15

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/**
 * POST /api/crm-storage/files/[id]/share-portal-chat
 *
 * Sends an existing CRM Storage file into a real client's portal chat.
 * Modeled directly on the council-reviewed app/api/captures/[id]/share-
 * portal-chat route: validates the recipient BEFORE copying any bytes (so a
 * rejected send never leaves an orphaned file sitting at a live URL),
 * re-validates right before the actual send (TOCTOU — the copy is the only
 * real gap between the two checks), never hands out a permanent public
 * link (the stored attachment_url points at the existing access-controlled
 * proxy, app/api/portal/chat/attachment/route.ts, which re-checks on every
 * view that the requester is staff or the specific client this was sent
 * to), and pings staff instantly on every send as an unrecallable-send
 * safety net.
 *
 * No "already shared" claim/resend flag — see lib/crm-storage/share-
 * actions.ts for why: a stored document may legitimately be sent to the
 * same or a different client more than once, unlike a one-shot capture.
 * The client disables its Send button for the duration of the request,
 * which is the same posture captures' own "resend" path deliberately
 * relies on instead of a server-side atomic claim.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isStaffUser(user)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 })
  }
  const { id: fileId } = await params

  const body = await request.json().catch(() => ({}))
  const contactId = typeof body.contact_id === "string" && body.contact_id ? body.contact_id : null
  const accountId = typeof body.account_id === "string" && body.account_id ? body.account_id : null
  if (!contactId && !accountId) return NextResponse.json({ error: "Who is this going to?" }, { status: 400 })

  const { data: file, error: fileErr } = await db
    .from("crm_storage_files")
    .select("id, file_name, mime_type, file_size, storage_bucket, storage_path")
    .eq("id", fileId)
    .is("deleted_at", null)
    .maybeSingle()
  if (fileErr || !file) return NextResponse.json({ error: "That file is gone. Please try again." }, { status: 404 })
  // Fail CLOSED on an unverifiable size, not open (bug-hunter, 2026-09-23) —
  // see the identical comment in share-team-chat/route.ts.
  if (file.file_size == null || Number.isNaN(Number(file.file_size))) {
    return NextResponse.json({ error: "This file's size couldn't be verified. Please try again." }, { status: 400 })
  }
  if (Number(file.file_size) > CHAT_SHARE_MAX_BYTES) {
    return NextResponse.json({ error: `That file is too large for chat. Maximum: ${CHAT_SHARE_MAX_MB} MB.` }, { status: 400 })
  }

  // Duplicate-send guard — see DUPLICATE_SEND_WINDOW_SECONDS above. Checked
  // here, before any validation work that follows, so a rapid-fire repeat of
  // an already-rejected send doesn't even re-run the eligibility queries.
  // This is the one CLIENT-FACING destination — a double-click or a second
  // open tab must not put the same document in front of a real client twice.
  {
    const recentCutoff = new Date(Date.now() - DUPLICATE_SEND_WINDOW_SECONDS * 1000).toISOString()
    let dupQuery = db
      .from("portal_messages")
      .select("id")
      .eq("attachment_name", file.file_name)
      .gte("created_at", recentCutoff)
    // A specific-contact send always stores that contact_id, so match on it
    // exactly. A whole-company send (no contactId given here) has NO
    // predictable contact_id to match — the real send route always resolves
    // one itself server-side (see the header comment above and the send
    // route's own resolveAdminReplyContact) — so match on account_id alone
    // instead; matching on `contact_id IS NULL` here would never hit and
    // silently disable this guard for every whole-company send.
    dupQuery = contactId ? dupQuery.eq("contact_id", contactId) : dupQuery.eq("account_id", accountId)
    const { data: recent } = await dupQuery.limit(1)
    if (recent && recent.length > 0) {
      return NextResponse.json({ error: "This was just sent to them — check their chat before sending again." }, { status: 429 })
    }
  }

  // Validate the send BEFORE touching Storage.
  if (contactId) {
    const { data: contact } = await db.from("contacts").select("email, portal_email_sent_at").eq("id", contactId).maybeSingle()
    if (!contact?.email || !contact.portal_email_sent_at) {
      return NextResponse.json({ error: "This person doesn't have portal access yet. Please try again." }, { status: 400 })
    }
  }
  if (accountId) {
    if (contactId) {
      const { data: link } = await db.from("account_contacts").select("contact_id").eq("account_id", accountId).eq("contact_id", contactId).maybeSingle()
      if (!link) return NextResponse.json({ error: "That company doesn't belong to this person anymore. Please search again." }, { status: 400 })
    }
    const { data: account } = await db.from("accounts").select("status").eq("id", accountId).maybeSingle()
    if (!account || !ACTIVE_ACCOUNT_STATUSES.has(account.status)) {
      return NextResponse.json({ error: "That company's account is closed — nothing was sent." }, { status: 400 })
    }
    if (!contactId) {
      const { count } = await db
        .from("account_contacts")
        .select("contacts!inner(id)", { count: "exact", head: true })
        .eq("account_id", accountId)
        .not("contacts.portal_email_sent_at", "is", null)
      if (!count) return NextResponse.json({ error: "Nobody at that company has portal access yet. Please try again." }, { status: 400 })
    }
  }

  // Copy: download from the private crm-files bucket, upload into the SAME
  // public bucket + path convention the existing chat-attachment proxy
  // already expects.
  const { data: blob, error: dlErr } = await db.storage.from(file.storage_bucket || CRM_STORAGE_BUCKET).download(file.storage_path)
  if (dlErr || !blob) {
    console.error("[crm-storage/share-portal-chat] download error:", dlErr)
    return NextResponse.json({ error: "Could not read the file. Please try again." }, { status: 500 })
  }
  const buffer = Buffer.from(await blob.arrayBuffer())
  const ext = (file.file_name?.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin"
  const dir = accountId ?? contactId
  const objectPath = `chat-attachments/${dir}/${randomUUID()}.${ext}`
  const { error: upErr } = await db.storage
    .from("assets")
    .upload(objectPath, buffer, { contentType: file.mime_type || "application/octet-stream", upsert: false })
  if (upErr) {
    console.error("[crm-storage/share-portal-chat] upload error:", upErr)
    return NextResponse.json({ error: "Could not share the file. Please try again." }, { status: 500 })
  }
  const attachmentUrl = `${PORTAL_BASE_URL}/api/portal/chat/attachment?path=${encodeURIComponent(objectPath)}`

  // Re-check right before sending, not just at the top of this request.
  if (contactId) {
    const { data: freshContact } = await db.from("contacts").select("email, portal_email_sent_at").eq("id", contactId).maybeSingle()
    if (!freshContact?.email || !freshContact.portal_email_sent_at) {
      return NextResponse.json({ error: "This person doesn't have portal access yet. Please try again." }, { status: 400 })
    }
  }
  if (accountId) {
    const { data: freshAccount } = await db.from("accounts").select("status").eq("id", accountId).maybeSingle()
    if (!freshAccount || !ACTIVE_ACCOUNT_STATUSES.has(freshAccount.status)) {
      return NextResponse.json({ error: "That company's account is closed — nothing was sent." }, { status: 400 })
    }
    if (!contactId) {
      const { count } = await db
        .from("account_contacts")
        .select("contacts!inner(id)", { count: "exact", head: true })
        .eq("account_id", accountId)
        .not("contacts.portal_email_sent_at", "is", null)
      if (!count) return NextResponse.json({ error: "Nobody at that company has portal access yet. Please try again." }, { status: 400 })
    }
  }

  // Deliver through the real staff send route — same identity, notifications,
  // and audit log every other staff portal-chat reply already gets. Forwards
  // the caller's own IP so the send route's rate limit is scoped per staff
  // member, not shared across everyone using this feature.
  const forwardedFor = request.headers.get("x-forwarded-for")
  const realIp = request.headers.get("x-real-ip")
  let sendRes: Response
  try {
    sendRes = await fetch(`${request.nextUrl.origin}/api/portal/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: request.headers.get("cookie") || "",
        ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
        ...(realIp ? { "x-real-ip": realIp } : {}),
      },
      body: JSON.stringify({
        ...(contactId
          ? { contact_id: contactId, account_id: accountId || undefined, sender_context: accountId ? "company" : "person" }
          : { account_id: accountId, addressed_to_company: true }),
        message: `Shared a file: ${file.file_name}`,
        attachment_url: attachmentUrl,
        attachment_name: file.file_name,
      }),
    })
  } catch (err) {
    console.error("[crm-storage/share-portal-chat] send route unreachable:", err)
    return NextResponse.json({ error: "Could not reach the client's chat. Please try again." }, { status: 500 })
  }
  if (!sendRes.ok) {
    const d = await sendRes.json().catch(() => ({}))
    return NextResponse.json({ error: d.error || "Could not send to the client." }, { status: sendRes.status })
  }
  const sendData = await sendRes.json().catch(() => ({}))

  // Instant alert: every send through this client-facing path pings staff
  // immediately — even a caught mistake can't recall the email/push the
  // send route just fired.
  try {
    const { sendPushToStaff } = await import("@/lib/team/notify")
    await sendPushToStaff({
      title: "File sent to client",
      body: `${file.file_name} was shared in the portal chat.`,
      url: accountId ? `/portal-chats?account=${accountId}` : `/portal-chats?contact=${contactId}`,
      tag: `crm-storage-portal-chat-${fileId}`,
    })
  } catch {
    // never block the send on an alert failure
  }

  return NextResponse.json({ ok: true, message_id: sendData.message?.id ?? null })
}
