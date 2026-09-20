/**
 * GET   /api/tax-form/[token]/data?code=...&preview=td   — fetch the tax return submission
 * PATCH /api/tax-form/[token]/data                       — track-open, or record the completed submission
 *   body: { code, preview?, action: "track_open" | "submit", submitted_data?, changed_fields?, upload_paths? }
 *
 * Replaces both tax-form pages' (the bare email-gated page and the
 * [code] page) direct anon-key browser queries against
 * tax_return_submissions. See lib/public-forms/verify-token-access.ts for
 * why a client-supplied token filter was never actually enforced by the
 * database, and app/api/ss4/[token]/data/route.ts for the identical pattern
 * already shipped on the EIN/ITIN forms.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { verifyTokenAccess } from "@/lib/public-forms/verify-token-access"

type Params = { params: Promise<{ token: string }> }

interface TaxFormRow {
  id: string
  access_code: string | null
  status: string
}

export async function GET(req: NextRequest, { params }: Params) {
  const { token } = await params
  const code = req.nextUrl.searchParams.get("code")
  const preview = req.nextUrl.searchParams.get("preview") === "td"

  const access = await verifyTokenAccess<TaxFormRow>(req, "tax_return_submissions", "*", token, code, preview)
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

  const access = await verifyTokenAccess<TaxFormRow>(
    req,
    "tax_return_submissions",
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
      .from("tax_return_submissions")
      .update({ opened_at: new Date().toISOString(), status: "opened" })
      .eq("id", access.row.id)
    if (error) return NextResponse.json({ error: "Failed to record view" }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (body.action === "submit") {
    // Same double-predicate write guard as the EIN/ITIN fix: the read-time
    // status check alone can't stop two near-simultaneous submits, so the
    // same condition is repeated on the UPDATE itself.
    if (access.row.status === "completed" || access.row.status === "reviewed") {
      return NextResponse.json({ error: "Already submitted" }, { status: 409 })
    }
    if (!body.submitted_data || typeof body.submitted_data !== "object") {
      return NextResponse.json({ error: "submitted_data required" }, { status: 400 })
    }
    const { data: updated, error } = await supabaseAdmin
      .from("tax_return_submissions")
      .update({
        submitted_data: body.submitted_data,
        changed_fields: body.changed_fields ?? {},
        upload_paths: body.upload_paths ?? [],
        confirmation_accepted: true,
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
