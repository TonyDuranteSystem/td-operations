import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isStaffUser } from "@/lib/auth"
import { correctRenewalDate } from "@/lib/operations/correct-renewal-date"

export const dynamic = "force-dynamic"

/**
 * POST /api/calendar/correct-renewal-date
 *
 * JSON { account_id, from, to, reason, note?, confirm_overdue? } — the Registered Agent renewal date only. The
 * Calendar's "Correct date" button. `from` is the date the pop-up showed; the
 * write is refused if the CRM no longer holds it. Everything else (portal
 * deadline row, open renewal job, audit line) is done by correctRenewalDate.
 *
 * Auth: signed-in TD STAFF only (stricter than Mark Filed's "not a client":
 * a managed partner must not be able to change a compliance date).
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if (!isStaffUser(user)) return NextResponse.json({ error: "Staff only" }, { status: 403 })

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "JSON body required" }, { status: 400 })
    }
    const { account_id, from, to, reason, note, confirm_overdue } = body as Record<string, unknown>
    if (typeof account_id !== "string" || !account_id) {
      return NextResponse.json({ error: "account_id is required" }, { status: 400 })
    }

    const result = await correctRenewalDate({
      accountId: account_id,
      from: typeof from === "string" ? from : "",
      to: typeof to === "string" ? to : "",
      reason: typeof reason === "string" ? reason : "",
      note: typeof note === "string" ? note : null,
      confirmOverdue: confirm_overdue === true,
      actor: user.email ?? user.id,
    })
    if (result.ok === false) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true, message: result.message, warnings: result.warnings })
  } catch (err) {
    console.error("correct-renewal-date failed:", err)
    const message = err instanceof Error && err.message ? err.message : "Unexpected error — please try again."
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
