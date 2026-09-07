import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStaffUser } from "@/lib/auth"
import { capturesTable } from "@/lib/captures/db"
import { WORKER_UPLOAD_BUCKET } from "@/lib/captures/storage"
import { ACTIVE_ACCOUNT_STATUSES } from "@/lib/captures/portal-destinations"
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
  const contactId = typeof body.contact_id === "string" && body.contact_id ? body.contact_id : null
  const accountId = typeof body.account_id === "string" && body.account_id ? body.account_id : null
  // True only for a deliberate re-share of a picture already sent once, from
  // the My Captures gallery's own "Share" button (2026-09-05) — see
  // lib/captures/share-actions.ts's header comment for the full reasoning.
  // The ORIGINAL post-capture flow never sends this, so its idempotency stays
  // exactly as strict as before.
  const resend = body.resend === true
  // Whole-company send (2026-09-06) — no specific contactId, always a real
  // account_id. Mirrors the main Portal Chats composer's own "Whole company"
  // send shape exactly (see below): account_id only, no contact_id, no
  // sender_context.
  if (!contactId && !accountId) return NextResponse.json({ error: "Who is this going to?" }, { status: 400 })

  const { data: capture, error: captureErr } = await capturesTable()
    .select("id, image_url, image_name, mime_type, size_bytes, note, title, captured_by_user_id, destination")
    .eq("id", captureId)
    .single()
  if (captureErr || !capture) return NextResponse.json({ error: "That capture is gone. Please try again." }, { status: 404 })
  if (capture.captured_by_user_id !== user.id) {
    return NextResponse.json({ error: "That isn't your capture." }, { status: 403 })
  }
  if (capture.destination && !resend) {
    return NextResponse.json({ error: "This was already shared." }, { status: 409 })
  }
  const priorDestination = capture.destination ?? null

  // Validate the send BEFORE touching Storage — see header comment.
  if (contactId) {
    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("email, portal_email_sent_at")
      .eq("id", contactId)
      .maybeSingle()
    if (!contact?.email || !contact.portal_email_sent_at) {
      return NextResponse.json({ error: "This person doesn't have portal access yet. Please try again." }, { status: 400 })
    }
  }
  if (accountId) {
    if (contactId) {
      const { data: link } = await supabaseAdmin
        .from("account_contacts")
        .select("contact_id")
        .eq("account_id", accountId)
        .eq("contact_id", contactId)
        .maybeSingle()
      if (!link) {
        return NextResponse.json({ error: "That company doesn't belong to this person anymore. Please search again." }, { status: 400 })
      }
    }
    const { data: account } = await supabaseAdmin.from("accounts").select("status, company_name").eq("id", accountId).maybeSingle()
    if (!account || !ACTIVE_ACCOUNT_STATUSES.has(account.status)) {
      return NextResponse.json({ error: "That company's account is closed — nothing was sent." }, { status: 400 })
    }
    if (!contactId) {
      // Whole-company send: at least one eligible (invited) contact must
      // actually be linked, or this would succeed while reaching nobody.
      const { count } = await supabaseAdmin
        .from("account_contacts")
        .select("contacts!inner(id)", { count: "exact", head: true })
        .eq("account_id", accountId)
        .not("contacts.portal_email_sent_at", "is", null)
      if (!count) {
        return NextResponse.json({ error: "Nobody at that company has portal access yet. Please try again." }, { status: 400 })
      }
    }
  }

  // Idempotency — CLAIM the capture atomically before doing any real work,
  // rather than just checking `destination` above and writing it at the end
  // (bug-hunter finding, 2026-09-04, second pass, confirmed by live testing:
  // firing two sends ~30ms apart both returned success and both messages
  // actually landed in the client's chat). The check above alone only
  // catches the common, sequential case — a genuinely concurrent pair of
  // requests can both pass it before either has written anything. This
  // conditional UPDATE is the only step in the whole request that Postgres
  // itself makes atomic: at most one concurrent caller can ever flip
  // `destination` from NULL here, so `.select()` coming back empty means
  // someone else won the race, and THIS request stops before ever touching
  // Storage or sending anything. Claims with the real, final label up front
  // (not a placeholder) and rolls back to NULL via rollbackClaim() below on
  // any failure past this point, so a failed send is still retriable rather
  // than permanently stuck "already shared."
  //
  // A resend can't use that same "must currently be NULL" gate — it's
  // sending BECAUSE `destination` is already set. The atomic claim only
  // exists to stop the exact same request from racing itself; for a resend,
  // that protection is deliberately lighter (the picker's own busy-guard,
  // already proven reliable for a real double-tap), not because it's a
  // lesser concern but because this path is a slow, multi-step, deliberately
  // reopened action, not the "one already-visible button, network hiccup"
  // pattern the atomic claim exists to close. Rollback restores the PRIOR
  // destination on a resend (there's a real previous send to preserve), not
  // NULL (which would erase it).
  const message = (capture.note?.trim() || capture.title || "Shared a screenshot").slice(0, 5000)
  // `id` must be present (DB CHECK on staff_captures.destination) — a
  // whole-company send has no contactId, so the account stands in; `account_id`
  // alongside it is what actually disambiguates the two shapes.
  const destinationValue = { type: "portal_chat", id: contactId ?? accountId, account_id: accountId, label: message.slice(0, 60) }
  const claimQuery = capturesTable().update({ destination: destinationValue }).eq("id", captureId)
  const { data: claimed, error: claimErr } = await (resend ? claimQuery : claimQuery.is("destination", null)).select("id")
  if (claimErr) {
    console.error("[captures/share-portal-chat] claim error:", claimErr)
    return NextResponse.json({ error: "Could not share the picture. Please try again." }, { status: 500 })
  }
  if (!claimed || claimed.length === 0) {
    return NextResponse.json({ error: "This was already shared." }, { status: 409 })
  }
  const rollbackClaim = async () => {
    await capturesTable().update({ destination: priorDestination }).eq("id", captureId)
  }

  // Copy: download from the private bucket, upload into the SAME public
  // bucket + path convention the existing proxy route already expects.
  const { data: blob, error: dlErr } = await supabaseAdmin.storage.from(WORKER_UPLOAD_BUCKET).download(capture.image_url)
  if (dlErr || !blob) {
    console.error("[captures/share-portal-chat] download error:", dlErr)
    await rollbackClaim()
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
    await rollbackClaim()
    return NextResponse.json({ error: "Could not share the picture. Please try again." }, { status: 500 })
  }
  const attachmentUrl = `${PORTAL_BASE_URL}/api/portal/chat/attachment?path=${encodeURIComponent(objectPath)}`

  // Re-check the account's status (and, symmetrically, the contact's own
  // portal-access fields for a personal send — bug-hunter finding,
  // 2026-09-04, second pass: the original only re-checked the company
  // branch) right before sending, not just at the top of this request — the
  // download+upload above is the only real gap between the two checks, so
  // re-running these cheap queries narrows that window to as little as it
  // can be without restructuring the shared /api/portal/chat send route
  // itself.
  if (contactId) {
    const { data: freshContact } = await supabaseAdmin.from("contacts").select("email, portal_email_sent_at").eq("id", contactId).maybeSingle()
    if (!freshContact?.email || !freshContact.portal_email_sent_at) {
      await rollbackClaim()
      return NextResponse.json({ error: "This person doesn't have portal access yet. Please try again." }, { status: 400 })
    }
  }
  if (accountId) {
    const { data: freshAccount } = await supabaseAdmin.from("accounts").select("status").eq("id", accountId).maybeSingle()
    if (!freshAccount || !ACTIVE_ACCOUNT_STATUSES.has(freshAccount.status)) {
      await rollbackClaim()
      return NextResponse.json({ error: "That company's account is closed — nothing was sent." }, { status: 400 })
    }
    if (!contactId) {
      const { count } = await supabaseAdmin
        .from("account_contacts")
        .select("contacts!inner(id)", { count: "exact", head: true })
        .eq("account_id", accountId)
        .not("contacts.portal_email_sent_at", "is", null)
      if (!count) {
        await rollbackClaim()
        return NextResponse.json({ error: "Nobody at that company has portal access yet. Please try again." }, { status: 400 })
      }
    }
  }

  // Deliver through the real staff send route — same identity, same
  // send-scope invariant, same client notifications, same audit log every
  // other staff portal-chat reply already gets. Forwards the caller's own
  // IP so the send route's rate limit is scoped per staff member, not
  // shared across everyone using this feature (bug-hunter finding,
  // 2026-09-04 — without this every hairpin call here looked like the same
  // caller to that check).
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
        // Whole-company (no contactId): mirrors the main Portal Chats
        // composer's OWN proven shape for this exact case exactly — account_id
        // alone, no contact_id, no sender_context, addressed_to_company:true.
        // Adding sender_context here would be wrong: 'company' requires (and
        // implies attributing the send to) a specific person via contactId;
        // there isn't one.
        ...(contactId
          ? { contact_id: contactId, account_id: accountId || undefined, sender_context: accountId ? "company" : "person" }
          : { account_id: accountId, addressed_to_company: true }),
        message,
        attachment_url: attachmentUrl,
        attachment_name: capture.image_name || "screenshot.png",
      }),
    })
  } catch (err) {
    console.error("[captures/share-portal-chat] send route unreachable:", err)
    await rollbackClaim()
    return NextResponse.json({ error: "Could not reach the client's chat. Please try again." }, { status: 500 })
  }
  if (!sendRes.ok) {
    const d = await sendRes.json().catch(() => ({}))
    await rollbackClaim()
    return NextResponse.json({ error: d.error || "Could not send to the client." }, { status: sendRes.status })
  }
  const sendData = await sendRes.json().catch(() => ({}))

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
