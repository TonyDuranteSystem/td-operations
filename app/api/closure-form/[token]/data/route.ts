/**
 * GET   /api/closure-form/[token]/data?code=...&preview=td   — fetch the closure submission
 * PATCH /api/closure-form/[token]/data                       — track-open, or record the completed submission
 *   body: { code, preview?, action: "track_open" | "submit", submitted_data?, changed_fields?, upload_paths? }
 *
 * Replaces both closure-form pages' (the bare email-gated page and the
 * [code] page) direct anon-key browser queries against closure_submissions.
 * Same pattern as app/api/tax-form/[token]/data/route.ts — see
 * lib/public-forms/verify-token-access.ts for why a client-supplied token
 * filter was never actually enforced by the database. The [code] page's own
 * prior check (`data.access_code !== code`) was a bare inequality with no
 * rate limit — the same weak-comparison shape already fixed on the SS-4/ITIN
 * pdf/upload-signed routes; verifyTokenAccess closes it here too.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { verifyTokenAccess } from "@/lib/public-forms/verify-token-access"

type Params = { params: Promise<{ token: string }> }

interface ClosureFormRow {
  id: string
  access_code: string | null
  status: string
}

export async function GET(req: NextRequest, { params }: Params) {
  const { token } = await params
  const code = req.nextUrl.searchParams.get("code")
  const preview = req.nextUrl.searchParams.get("preview") === "td"

  const access = await verifyTokenAccess<ClosureFormRow>(req, "closure_submissions", "*", token, code, preview)
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

  const access = await verifyTokenAccess<ClosureFormRow>(
    req,
    "closure_submissions",
    "id, access_code, status",
    token,
    code,
    preview,
  )
  if (access.error) {
    return NextResponse.json({ error: access.error }, { status: access.status ?? 500 })
  }

  if (body.action === "track_open") {
    // Mirrors both pages' prior client-side behavior exactly: only a
    // pending/sent submission promotes to "opened".
    if (access.row.status !== "pending" && access.row.status !== "sent") {
      return NextResponse.json({ ok: true, skipped: true })
    }
    const { error } = await supabaseAdmin
      .from("closure_submissions")
      .update({ opened_at: new Date().toISOString(), status: "opened" })
      .eq("id", access.row.id)
    if (error) return NextResponse.json({ error: "Failed to record view" }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (body.action === "submit") {
    // Same double-predicate write guard as every other converted form: the
    // read-time status check alone can't stop two near-simultaneous submits,
    // so the same condition is repeated on the UPDATE itself.
    if (access.row.status === "completed" || access.row.status === "reviewed") {
      return NextResponse.json({ error: "Already submitted" }, { status: 409 })
    }
    if (!body.submitted_data || typeof body.submitted_data !== "object") {
      return NextResponse.json({ error: "submitted_data required" }, { status: 400 })
    }
    const forwardedFor = req.headers.get("x-forwarded-for")
    const clientIpAddr = forwardedFor ? forwardedFor.split(",")[0].trim() : ""
    const { data: updated, error } = await supabaseAdmin
      .from("closure_submissions")
      .update({
        submitted_data: body.submitted_data,
        changed_fields: body.changed_fields ?? {},
        upload_paths: body.upload_paths ?? [],
        status: "completed",
        completed_at: new Date().toISOString(),
        client_ip: clientIpAddr,
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
