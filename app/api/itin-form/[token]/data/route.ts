/**
 * GET   /api/itin-form/[token]/data?code=...&preview=td   — fetch the ITIN submission for the wizard
 * PATCH /api/itin-form/[token]/data                       — track-open, or record the completed submission
 *   body: { code, preview?, action: "track_open" | "submit", submitted_data?, changed_fields?, upload_paths? }
 *
 * Replaces the ITIN wizard's direct anon-key browser queries against
 * itin_submissions — including the FINAL submit, which used to write the
 * client's full submitted data (name, DOB, foreign address, foreign tax id,
 * reason for ITIN) straight from the browser with no server-side check
 * beyond the client's own `.eq("token", token)` filter. The table's RLS
 * policy allowed anon SELECT/UPDATE unconditionally, so that filter was not
 * actually enforced by the database. See lib/public-forms/verify-token-access.ts.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { verifyTokenAccess } from "@/lib/public-forms/verify-token-access"

type Params = { params: Promise<{ token: string }> }

interface ItinRow {
  id: string
  access_code: string | null
  status: string
  view_count: number | null
}

export async function GET(req: NextRequest, { params }: Params) {
  const { token } = await params
  const code = req.nextUrl.searchParams.get("code")
  const preview = req.nextUrl.searchParams.get("preview") === "td"

  const access = await verifyTokenAccess<ItinRow>(req, "itin_submissions", "*", token, code, preview)
  if (access.error) {
    return NextResponse.json({ error: access.error }, { status: access.status ?? 500 })
  }

  return NextResponse.json({ data: access.row, isAdmin: access.isAdmin })
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { token } = await params
  const body = await req.json().catch(() => ({}))
  const code = body.code ?? null
  const preview = body.preview === "td"

  const access = await verifyTokenAccess<ItinRow>(
    req,
    "itin_submissions",
    "id, access_code, status, view_count, prefilled_data",
    token,
    code,
    preview,
  )
  if (access.error) {
    return NextResponse.json({ error: access.error }, { status: access.status ?? 500 })
  }

  if (body.action === "track_open") {
    // Mirrors the page's prior client-side behavior exactly: only pending/sent
    // promotes to "opened"; an already-opened, completed, or reviewed
    // submission is left untouched.
    if (access.row.status !== "pending" && access.row.status !== "sent") {
      return NextResponse.json({ ok: true, skipped: true })
    }
    const { error } = await supabaseAdmin
      .from("itin_submissions")
      .update({ opened_at: new Date().toISOString(), status: "opened" })
      .eq("id", access.row.id)
    if (error) return NextResponse.json({ error: "Failed to record view" }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (body.action === "submit") {
    // Only a submission not already completed/reviewed may be submitted —
    // the page never exposed the form once submitted (early-return on
    // status === 'completed' | 'reviewed'), so enforce the same server-side.
    // As with SS-4's "sign", the read-time check alone can't stop two
    // near-simultaneous submits, so the same condition is repeated on the
    // UPDATE itself and a zero-row result is a real 409, not a silent no-op.
    if (access.row.status === "completed" || access.row.status === "reviewed") {
      return NextResponse.json({ error: "Already submitted" }, { status: 409 })
    }
    if (!body.submitted_data || typeof body.submitted_data !== "object") {
      return NextResponse.json({ error: "submitted_data required" }, { status: 400 })
    }
    const { data: updated, error } = await supabaseAdmin
      .from("itin_submissions")
      .update({
        submitted_data: body.submitted_data,
        changed_fields: body.changed_fields ?? {},
        upload_paths: body.upload_paths ?? [],
        status: "completed",
        completed_at: new Date().toISOString(),
        client_user_agent: req.headers.get("user-agent") ?? "",
      })
      .eq("id", access.row.id)
      .not("status", "in", "(completed,reviewed)")
      .select("id")
      .maybeSingle()
    if (error) return NextResponse.json({ error: "Failed to record submission" }, { status: 500 })
    if (!updated) {
      return NextResponse.json({ error: "Already submitted" }, { status: 409 })
    }
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}
