import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser } from "@/lib/auth"
import { checkMailboxAccess } from "@/lib/inbox/mailbox-access"
import { confirmWorkerEmailSend } from "@/lib/inbox/worker-email-send"
import { NextRequest, NextResponse } from "next/server"

/**
 * POST /api/inbox/worker-chat/confirm-send
 *
 * The staff's explicit Confirm (or Cancel) on an email the Inbox worker prepared
 * WITH an attachment. This — a real human click — is gate 2: the worker only ever
 * froze the payload; nothing left the building until this endpoint runs.
 *
 * Body: { prepared_id, action: "confirm" | "cancel" }
 */
export async function POST(req: NextRequest) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const preparedId: string | null = typeof body.prepared_id === "string" ? body.prepared_id : null
  const action: string = body.action === "cancel" ? "cancel" : "confirm"
  // WHICH OF OUR ADDRESSES IT GOES OUT FROM — chosen by the staff member on the
  // card (Antonio, 2026-07-29). Only the two real mailboxes are accepted; anything
  // else is ignored and the frozen row's own mailbox stands.
  const mailboxChoice: "support" | "antonio" | undefined =
    body.mailbox === "antonio" ? "antonio" : body.mailbox === "support" ? "support" : undefined
  // The signature the staff member picked on the card (full / compact / none).
  // Narrowed like every untrusted body field. ABSENT stays undefined — the
  // default lives in ONE place (the dispatcher), so a surface that posts no
  // pick (Team Chat, sidebar, Portal Chats' email card, older bundles) tracks
  // whatever the dispatch-side default is rather than pinning today's.
  const { parseSignatureVariant } = await import("@/lib/email/signature")
  const signatureVariant =
    body.signature_variant === undefined ? undefined : parseSignatureVariant(body.signature_variant)
  if (!preparedId) return NextResponse.json({ error: "prepared_id required" }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: row } = await db
    .from("worker_prepared_sends")
    .select("id, kind, mailbox, status, actor")
    .eq("id", preparedId)
    .maybeSingle()
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (row.status !== "pending") {
    // Says "message", not "email" — a superseded PORTAL draft resolves here too, and
    // the Reformulate button makes that an everyday event rather than an edge case.
    return NextResponse.json({ error: `This message was already ${row.status}.` }, { status: 409 })
  }

  // ── PORTAL BRANCH ──────────────────────────────────────────────────────────
  // Read the kind FROM THE ROW and branch BEFORE anything touches `mailbox`. All
  // four card surfaces post a mailbox unconditionally, and the email claim writes it
  // back — which on a portal row violates the shape constraint, fails the claim, and
  // (because supabase-js returns errors rather than throwing) reports "already sent"
  // while nothing was sent and the row is still pending. Branching first is what
  // stops that; the constraint is the floor underneath it, not the mechanism.
  if (row.kind === "portal") {
    const { confirmPortalSend } = await import("@/lib/inbox/worker-portal-freeze")
    const result = await confirmPortalSend({
      preparedId,
      actorEmail: user.email ?? "unknown",
      rowActor: row.actor ?? "",
      accountId: typeof body.account_id === "string" ? body.account_id : null,
      contactId: typeof body.contact_id === "string" ? body.contact_id : null,
      action: action as "confirm" | "cancel",
    })
    if (result.ok === false) {
      return NextResponse.json({ error: result.reason }, { status: result.status ?? 400 })
    }
    return NextResponse.json({ ok: true, ...result })
  }

  // The confirming staff must have access to the mailbox this sends AS — an
  // antonio@ send needs antonio-mailbox access, same gate as reading it.
  // Check access to what will ACTUALLY be used: the staff member's choice if they
  // made one, else the row's own mailbox. Choosing "antonio" without antonio-mailbox
  // access is refused here — the card may offer both, the server decides.
  const mailboxKey = mailboxChoice ?? (row.mailbox?.startsWith("antonio") ? "antonio" : "support")
  if (!(await checkMailboxAccess(mailboxKey))) {
    return NextResponse.json({ error: "Not authorized for this mailbox" }, { status: 403 })
  }

  if (action === "cancel") {
    const { data: cancelled } = await db
      .from("worker_prepared_sends")
      .update({ status: "cancelled", resolved_at: new Date().toISOString() })
      .eq("id", preparedId)
      .eq("status", "pending")
      .select("attachments")
    // Cancel is THE button the warnings are designed to make people press, so
    // it is the most common way a draft dies — and the copies we made for it can
    // never be sent now. Discarded from what the guarded UPDATE actually
    // returned, so a row claimed by a concurrent confirm keeps its bytes.
    const { discardCopies } = await import("@/lib/inbox/sendable-attachment")
    for (const row of (cancelled ?? []) as Array<{ attachments?: Array<{ path?: string; copied?: boolean }> }>) {
      await discardCopies(row.attachments)
    }
    return NextResponse.json({ ok: true, cancelled: true })
  }

  const result = await confirmWorkerEmailSend(preparedId, user.email ?? "unknown", mailboxChoice, signatureVariant)
  if (result.ok === false) {
    return NextResponse.json({ error: result.reason }, { status: 400 })
  }
  return NextResponse.json({ ok: true, sent: true, to: result.to })
}
