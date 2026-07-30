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
  if (!preparedId) return NextResponse.json({ error: "prepared_id required" }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: row } = await db
    .from("worker_prepared_sends")
    .select("id, mailbox, status")
    .eq("id", preparedId)
    .maybeSingle()
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (row.status !== "pending") {
    return NextResponse.json({ error: `This email was already ${row.status}.` }, { status: 409 })
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
    await db
      .from("worker_prepared_sends")
      .update({ status: "cancelled", resolved_at: new Date().toISOString() })
      .eq("id", preparedId)
      .eq("status", "pending")
    return NextResponse.json({ ok: true, cancelled: true })
  }

  const result = await confirmWorkerEmailSend(preparedId, user.email ?? "unknown", mailboxChoice)
  if (result.ok === false) {
    return NextResponse.json({ error: result.reason }, { status: 400 })
  }
  return NextResponse.json({ ok: true, sent: true, to: result.to })
}
