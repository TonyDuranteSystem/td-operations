import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { applyRenewalAutoFix } from "@/lib/operations/renewal-problem-apply"

export const dynamic = "force-dynamic"

/**
 * POST /api/calendar/fix-renewal-problem
 *
 * One-click apply for a problem card on the Compliance Truth Calendar
 * (plan 89c951a7). The body carries the fix EXACTLY as the card showed it;
 * lib/operations/renewal-problem-apply revalidates against a live recompute
 * and writes with a checked update — a stale card fails with a refresh
 * message instead of writing anything.
 *
 * Auth: any logged-in dashboard user (same gate as file-renewal).
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "JSON body required" }, { status: 400 })
    }
    const { account_id, obligation, action, auto_fix } = body as {
      account_id?: unknown
      obligation?: unknown
      action?: unknown
      auto_fix?: { column?: unknown; from?: unknown; to?: unknown }
    }
    if (typeof account_id !== "string" || !account_id) {
      return NextResponse.json({ error: "account_id is required" }, { status: 400 })
    }
    if (obligation !== "ra_renewal" && obligation !== "annual_report") {
      return NextResponse.json({ error: 'obligation must be "ra_renewal" or "annual_report"' }, { status: 400 })
    }
    if (action !== "roll_forward_date" && action !== "derive_missing_date") {
      return NextResponse.json({ error: `Action "${String(action)}" is not one-click fixable` }, { status: 400 })
    }
    const column = auto_fix?.column
    const from = auto_fix?.from ?? null
    const to = auto_fix?.to
    if (column !== "ra_renewal_date" && column !== "annual_report_due_date") {
      return NextResponse.json({ error: "auto_fix.column invalid" }, { status: 400 })
    }
    if (typeof to !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return NextResponse.json({ error: "auto_fix.to must be YYYY-MM-DD" }, { status: 400 })
    }
    if (from !== null && (typeof from !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(from))) {
      return NextResponse.json({ error: "auto_fix.from must be YYYY-MM-DD or null" }, { status: 400 })
    }
    const fromValue: string | null = typeof from === "string" ? from : null

    const result = await applyRenewalAutoFix({
      accountId: account_id,
      obligation,
      action,
      autoFix: { column, from: fromValue, to },
      actor: user.email ?? user.id,
    })

    if (result.ok === false) {
      return NextResponse.json({ error: result.error }, { status: 409 })
    }
    return NextResponse.json({ ok: true, applied: result.applied, status: result.status, warning: result.warning })
  } catch (err) {
    console.error("fix-renewal-problem failed:", err)
    const message = err instanceof Error && err.message ? err.message : "Unexpected error — please try again."
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
