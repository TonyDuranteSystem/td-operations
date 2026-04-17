import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isAdmin } from "@/lib/auth"
import { reconcileInvoiceMirror } from "@/lib/operations/payment"

/**
 * POST /api/crm/admin-actions/reconcile-invoice-mirror
 *
 * Task 918fe55e — forces the client_expenses mirror row to match the
 * current payments row for a TD invoice. Used as a last-resort repair
 * when the mirror has drifted out of sync (pattern: payments says Paid,
 * client_expenses still says Overdue — client portal stuck showing the
 * invoice as unpaid).
 *
 * Body: { payment_id: string, reason?: string }
 * Response: { success, changed, before?, after?, message }
 *
 * Admin-only. Idempotent. Logs to action_log.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  const body = (await request.json().catch(() => null)) as
    | { payment_id?: string; reason?: string }
    | null

  if (!body?.payment_id) {
    return NextResponse.json({ error: "payment_id required" }, { status: 400 })
  }

  const result = await reconcileInvoiceMirror(body.payment_id)

  if (!result.success) {
    return NextResponse.json({ error: result.error ?? "Reconcile failed" }, { status: 500 })
  }

  await supabaseAdmin.from("action_log").insert({
    actor: `dashboard:${user.email?.split("@")[0] ?? "unknown"}`,
    action_type: "update",
    table_name: "client_expenses",
    record_id: body.payment_id,
    summary: result.changed
      ? "Reconciled TD invoice mirror"
      : "TD invoice mirror — no drift (no-op)",
    details: {
      payment_id: body.payment_id,
      before: result.before,
      after: result.after,
      changed: result.changed,
      reason: body.reason ?? null,
    },
  })

  return NextResponse.json({
    success: true,
    changed: result.changed,
    before: result.before,
    after: result.after,
    message: result.changed
      ? `Mirror reconciled. Status: ${result.before?.ce_status} → ${result.after?.ce_status}.`
      : "No drift — mirror already matches internal record.",
  })
}
